import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { ReporterSpec, ResolvedConfig } from '../config';
import { mutateSource } from '../operators/test/astMutator';
import { registry as defaultRegistry, OperatorRegistry } from '../operators/registry';
import { buildPweModel } from '../pwe/pwe';
import { runReporters } from '../report/reporters';
import type { BaselineResult, MutantDescriptor, MutantResult, PwePage, RunReport, SuiteTrace, TestTrace } from '../types';
import { ensureDir, readJson, rmrf, writeJson } from '../util/fs';
import { Logger, silentLogger } from '../util/log';
import { runPool } from '../util/pool';
import { hash32, mulberry32 } from '../util/random';
import { classify, countBy, countResults, gapCategory, isFailure, perLayer } from './classifier';
import { runPlaywright, testKey } from './executor';
import { generateMutants, readTestSources } from './generator';
import { createSandbox, removeSandbox, Sandbox } from './sandbox';

export const VERSION: string = require('../../../package.json').version;

export type Phase = 'server' | 'baseline' | 'trace' | 'pwe' | 'generate' | 'execute' | 'report' | 'done';

/** Events emitted by MutationEngine. */
export interface EngineEvents {
  phase: [phase: Phase];
  baseline: [baseline: BaselineResult];
  trace: [trace: SuiteTrace];
  pwe: [pages: PwePage[]];
  generated: [mutants: MutantDescriptor[]];
  'mutant:start': [mutant: MutantDescriptor];
  'mutant:result': [result: MutantResult, progress: { done: number; total: number }];
  report: [report: RunReport, files: string[]];
}

export interface EngineOptions {
  logger?: Logger;
  /** Operator registry (default: the process-wide registry). */
  registry?: OperatorRegistry;
  /**
   * In-memory test files (path relative to testDir -> source). They are added
   * to (or replace files of) the suite in every sandbox, which lets test
   * generators evaluate tests without writing them into the project.
   */
  inlineTests?: Record<string, string>;
  /** Namespace for sandboxes/run folders (default: random); allows concurrent engines. */
  runId?: string;
}

export interface RunOptions {
  /** Use this trace instead of tracing (e.g. produced by a crawler with attachRecorder). */
  trace?: SuiteTrace;
  /** Reuse `<outputDir>/trace.json` when it exists. */
  reuseTrace?: boolean;
  /** Execute these mutants instead of generating them. */
  mutants?: MutantDescriptor[];
  /** Reporters (default: config.reporters); `false` disables reporting. */
  reporters?: ReporterSpec[] | false;
  signal?: AbortSignal;
}

export class AbortError extends Error {
  constructor() {
    super('MultilayerMT run aborted');
    this.name = 'AbortError';
  }
}

/**
 * Mutation Engine (thesis Sec. 4.2, execution model of Sec. 4.5):
 *   1. trace collection   2. PWE extraction   3. mutant generation
 *   4. mutant execution   5. result aggregation   6. report generation
 *
 * Each step is also available as a method, so callers can run, replace or
 * inspect individual steps.
 */
export class MutationEngine extends EventEmitter {
  readonly logger: Logger;
  readonly registry: OperatorRegistry;
  readonly runId: string;
  private inlineTests: Record<string, string>;
  private baseSandbox: Sandbox | null = null;
  private server: ChildProcess | null = null;

  constructor(readonly cfg: ResolvedConfig, opts: EngineOptions = {}) {
    super();
    this.logger = opts.logger ?? silentLogger;
    this.registry = opts.registry ?? defaultRegistry;
    this.inlineTests = opts.inlineTests ?? {};
    this.runId = opts.runId ?? `r${Date.now().toString(36)}${(hash32(String(Math.random())) % 1296).toString(36)}`;
  }

  override on<K extends keyof EngineEvents>(event: K, listener: (...args: EngineEvents[K]) => void): this {
    return super.on(event, listener as (...a: any[]) => void);
  }
  override once<K extends keyof EngineEvents>(event: K, listener: (...args: EngineEvents[K]) => void): this {
    return super.once(event, listener as (...a: any[]) => void);
  }
  override emit<K extends keyof EngineEvents>(event: K, ...args: EngineEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  get paths() {
    const out = this.cfg.abs.outputDir;
    return {
      trace: path.join(out, 'trace.json'),
      pwe: path.join(out, `pwe-${this.cfg.maxPwe}.json`),
      mutants: path.join(out, `mutants-pwe${this.cfg.maxPwe}.json`),
      report: path.join(out, `report-pwe${this.cfg.maxPwe}.json`),
      html: path.join(out, `report-pwe${this.cfg.maxPwe}.html`),
      traceRaw: path.join(out, 'trace-raw'),
      runs: path.join(out, 'runs'),
    };
  }

  /** Load the plugin modules listed in the config (idempotent). */
  async init(): Promise<void> {
    await this.registry.loadPlugins(this.cfg.abs.plugins);
  }

  /* ---------------------------------------------------------- app server */

  async startServer(): Promise<void> {
    const s = this.cfg.server;
    if (!s) return;
    this.emit('phase', 'server');
    if (await isUp(s.url)) {
      this.logger.info(`server already running at ${s.url}`);
      return;
    }
    this.logger.info(`starting server: ${s.command}`);
    this.server = spawn(s.command, { shell: true, cwd: path.resolve(this.cfg.abs.root, s.cwd || '.'), stdio: 'ignore', detached: process.platform !== 'win32' });
    const deadline = Date.now() + (s.timeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      if (await isUp(s.url)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server did not come up at ${s.url}`);
  }

  stopServer(): void {
    if (!this.server?.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-this.server.pid, 'SIGTERM');
      else this.server.kill();
    } catch {
      /* already gone */
    }
    this.server = null;
  }

  private sandboxName(name: string): string {
    return `${this.runId}/${name}`;
  }

  private base(): Sandbox {
    if (!this.baseSandbox) this.baseSandbox = createSandbox(this.cfg, this.sandboxName('base'), this.inlineTests);
    return this.baseSandbox;
  }

  /** Remove sandboxes of this run (unless keepSandboxes). */
  cleanup(): void {
    this.baseSandbox = null;
    if (this.cfg.keepSandboxes) return;
    rmrf(path.join(this.cfg.abs.sandboxDir, this.runId));
    const dir = this.cfg.abs.sandboxDir;
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) rmrf(dir);
  }

  /* --------------------------------------------- step 1: trace + baseline */

  async trace(signal?: AbortSignal): Promise<SuiteTrace> {
    const sandbox = this.base();
    const workers = this.cfg.baselineWorkers ?? this.cfg.workers;
    this.emit('phase', 'baseline');
    this.logger.info('baseline run (no mutation)...');
    const baselineRun = await runPlaywright(this.cfg, {
      sandbox, files: [], env: { MLMT_MODE: 'off' }, workers, timeoutMs: this.cfg.mutantTimeoutMs * 4, runId: `${this.runId}-baseline`, signal, logger: this.logger,
    });
    if (signal?.aborted) throw new AbortError();
    if (!baselineRun.reportFound) throw new Error(`baseline run produced no report:\n${baselineRun.stderr}`);
    const baseline: BaselineResult = {
      durationMs: baselineRun.durationMs,
      passed: baselineRun.tests.filter((t) => t.status === 'expected').map(testKey),
      failed: baselineRun.tests.filter((t) => isFailure(t)).map(testKey),
      ok: baselineRun.tests.length > 0 && baselineRun.tests.every((t) => !isFailure(t)),
    };
    this.emit('baseline', baseline);
    this.logger.info(`baseline: ${baseline.passed.length} passed, ${baseline.failed.length} failed in ${(baseline.durationMs / 1000).toFixed(1)}s`);
    if (!baseline.ok) {
      if (this.cfg.requireGreenBaseline) throw new Error(`baseline is not green:\n  ${baseline.failed.join('\n  ') || baselineRun.errors.join('\n  ')}`);
      this.logger.warn('baseline is not green; failing tests are ignored when classifying mutants:');
      baseline.failed.forEach((f) => this.logger.warn('  ' + f));
    }

    this.emit('phase', 'trace');
    this.logger.info('trace run (recording interactions, DOM snapshots and network)...');
    rmrf(this.paths.traceRaw);
    ensureDir(this.paths.traceRaw);
    await runPlaywright(this.cfg, {
      sandbox, files: [], env: { MLMT_MODE: 'trace', MLMT_OUT_DIR: this.paths.traceRaw }, workers,
      timeoutMs: this.cfg.mutantTimeoutMs * 4, runId: `${this.runId}-trace`, signal, logger: this.logger,
    });
    if (signal?.aborted) throw new AbortError();
    const tests: TestTrace[] = fs
      .readdirSync(this.paths.traceRaw)
      .filter((f) => f.startsWith('trace-'))
      .sort()
      .map((f) => readJson<TestTrace>(path.join(this.paths.traceRaw, f)));
    const trace: SuiteTrace = { createdAt: new Date().toISOString(), baseline, tests };
    writeJson(this.paths.trace, trace);
    const pages = new Set(tests.flatMap((t) => Object.keys(t.snapshots)));
    this.logger.info(`trace: ${tests.length} test(s), ${pages.size} page(s), ${tests.reduce((n, t) => n + t.interactions.length, 0)} interaction(s), ${tests.reduce((n, t) => n + t.network.length, 0)} response(s)`);
    this.emit('trace', trace);
    return trace;
  }

  async loadOrTrace(reuse: boolean, signal?: AbortSignal): Promise<SuiteTrace> {
    if (reuse && fs.existsSync(this.paths.trace)) {
      this.logger.info(`reusing trace ${this.paths.trace}`);
      const t = readJson<SuiteTrace>(this.paths.trace);
      this.emit('trace', t);
      return t;
    }
    return this.trace(signal);
  }

  /* ------------------------------------------------ steps 2-3: PWE + gen */

  pwe(trace: SuiteTrace): PwePage[] {
    this.emit('phase', 'pwe');
    const model = buildPweModel(trace, this.cfg.maxPwe);
    writeJson(this.paths.pwe, model);
    this.logger.info(`PWE (top ${this.cfg.maxPwe}/page): ${model.reduce((n, p) => n + p.selected.length, 0)} element(s) on ${model.length} page(s)`);
    this.emit('pwe', model);
    return model;
  }

  generate(trace: SuiteTrace, pwe: PwePage[]): MutantDescriptor[] {
    this.emit('phase', 'generate');
    let mutants = generateMutants(this.cfg, pwe, trace, { registry: this.registry, testSources: readTestSources(this.cfg, this.inlineTests) });
    if (this.cfg.maxMutants > 0 && mutants.length > this.cfg.maxMutants) {
      const rand = mulberry32(this.cfg.seed);
      mutants = mutants
        .map((m) => ({ m, k: rand() }))
        .sort((a, b) => a.k - b.k)
        .slice(0, this.cfg.maxMutants)
        .map((x) => x.m)
        .sort((a, b) => a.id.localeCompare(b.id));
      this.logger.info(`sampled ${mutants.length} mutants (maxMutants)`);
    }
    writeJson(this.paths.mutants, mutants);
    const by = (l: string) => mutants.filter((m) => m.layer === l).length;
    this.logger.info(`generated ${mutants.length} mutants (dom ${by('dom')}, network ${by('network')}, test ${by('test')})`);
    this.emit('generated', mutants);
    return mutants;
  }

  /* ------------------------------------------------- step 4: execution */

  async executeOne(m: MutantDescriptor, baselinePassed: Set<string>, signal?: AbortSignal): Promise<MutantResult> {
    if (m.precheckFailed) {
      return { mutant: m, status: 'SKIPPED', applied: false, applications: 0, durationMs: 0, tests: [], reason: m.precheckFailed };
    }
    const runDir = path.join(this.paths.runs, m.id);
    rmrf(runDir);
    const appliedDir = path.join(runDir, 'applied');
    ensureDir(appliedDir);
    const mutantFile = path.join(runDir, 'mutant.json');
    writeJson(mutantFile, m);

    let sandbox: Sandbox;
    let ownSandbox = false;
    if (m.layer === 'test' && m.target.kind === 'test') {
      const file = m.target.file;
      const src = this.inlineTests[file] ?? fs.readFileSync(path.join(this.cfg.abs.testDir, file), 'utf8');
      const mutated = mutateSource(m.operator, file, src, m.target.site, m.params);
      sandbox = createSandbox(this.cfg, this.sandboxName(m.id), { ...this.inlineTests, [file]: mutated });
      fs.writeFileSync(path.join(runDir, 'mutated-' + path.basename(file)), mutated);
      ownSandbox = true;
    } else {
      sandbox = this.base();
    }

    const run = await runPlaywright(this.cfg, {
      sandbox,
      files: m.testFiles,
      env: { MLMT_MODE: m.layer === 'test' ? 'off' : 'mutant', MLMT_MUTANT_FILE: mutantFile, MLMT_OUT_DIR: appliedDir },
      workers: 1,
      timeoutMs: this.cfg.mutantTimeoutMs,
      runId: m.id,
      signal,
      logger: this.logger,
    });
    if (ownSandbox && !this.cfg.keepSandboxes) removeSandbox(sandbox);

    let applications = m.layer === 'test' ? 1 : 0;
    const details: string[] = [];
    if (fs.existsSync(appliedDir)) {
      for (const f of fs.readdirSync(appliedDir)) {
        const a = readJson<{ applied: string[] }>(path.join(appliedDir, f));
        applications += a.applied.length;
        details.push(...a.applied.slice(0, 3));
      }
    }
    const { status, reason } = run.aborted ? { status: 'ERROR' as const, reason: 'aborted' } : classify(m, run, baselinePassed, applications);
    const result: MutantResult = {
      mutant: m,
      status,
      applied: applications > 0,
      applications,
      durationMs: run.durationMs,
      tests: run.tests,
      reason: details.length ? `${reason} | applied: ${[...new Set(details)].slice(0, 3).join('; ')}` : reason,
    };
    if (status === 'SURVIVED') result.gapCategory = gapCategory(m.operator);
    if (!this.cfg.keepSandboxes) rmrf(path.join(runDir, 'test-results'));
    writeJson(path.join(runDir, 'result.json'), result);
    return result;
  }

  async execute(mutants: MutantDescriptor[], baseline: BaselineResult, signal?: AbortSignal): Promise<MutantResult[]> {
    this.emit('phase', 'execute');
    const baselinePassed = new Set(baseline.passed);
    let done = 0;
    const total = mutants.length;
    const results = await runPool(mutants, this.cfg.workers, async (m) => {
      if (signal?.aborted) return null;
      this.emit('mutant:start', m);
      const r = await this.executeOne(m, baselinePassed, signal);
      if (signal?.aborted) return null;
      done++;
      this.logger.info(`[${done}/${total}] ${m.id} ${m.operator.padEnd(28)} ${r.status.padEnd(8)} ${(r.durationMs / 1000).toFixed(1)}s  ${m.target.description.slice(0, 80)}`);
      this.emit('mutant:result', r, { done, total });
      return r;
    });
    if (signal?.aborted) throw new AbortError();
    return results.filter((r): r is MutantResult => !!r);
  }

  /* ------------------------------------------- steps 5-6: aggregation */

  buildReport(results: MutantResult[], pwe: PwePage[], trace: SuiteTrace, startedAt: Date, wallTimeMs: number): RunReport {
    const survived = results.filter((r) => r.status === 'SURVIVED');
    const gaps = { 'Weak Assertions': 0, 'Missing Error Handling': 0, 'Timing Dependencies': 0 };
    for (const r of survived) gaps[r.gapCategory!]++;
    return {
      tool: 'MultilayerMT',
      version: VERSION,
      app: this.cfg.app,
      config: { maxPwe: this.cfg.maxPwe, workers: this.cfg.workers, layers: this.cfg.layers, testSelection: this.cfg.testSelection },
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      wallTimeMs,
      sumMutantTimeMs: results.reduce((n, r) => n + r.durationMs, 0),
      baselineMs: trace.baseline.durationMs,
      totals: countResults(results),
      perLayer: perLayer(results),
      perOperator: countBy(results, (r) => r.mutant.operator),
      gapCategories: gaps,
      pwe,
      results,
    };
  }

  /** Full pipeline: trace -> PWE -> generate -> execute -> report. */
  async run(opts: RunOptions = {}): Promise<RunReport> {
    const startedAt = new Date();
    const { signal } = opts;
    try {
      await this.init();
      await this.startServer();
      let trace: SuiteTrace;
      if (opts.trace) {
        trace = opts.trace;
        writeJson(this.paths.trace, trace);
        this.emit('trace', trace);
      } else trace = await this.loadOrTrace(!!opts.reuseTrace, signal);
      const pwe = this.pwe(trace);
      const mutants = opts.mutants ?? this.generate(trace, pwe);
      const t0 = Date.now();
      const results = await this.execute(mutants, trace.baseline, signal);
      const report = this.buildReport(results, pwe, trace, startedAt, Date.now() - t0);
      this.emit('phase', 'report');
      const files = opts.reporters === false ? [] : await runReporters(report, this.cfg, this.logger, opts.reporters ?? this.cfg.reporters);
      this.emit('report', report, files);
      this.emit('phase', 'done');
      return report;
    } finally {
      this.cleanup();
      this.stopServer();
    }
  }
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.status < 500;
  } catch {
    return false;
  }
}
