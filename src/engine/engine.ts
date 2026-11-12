import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ResolvedConfig } from '../config';
import { mutateSource } from '../operators/test/astMutator';
import { buildPweModel } from '../pwe/pwe';
import type { BaselineResult, MutantDescriptor, MutantResult, PwePage, RunReport, SuiteTrace, TestTrace } from '../types';
import { ensureDir, readJson, rmrf, writeJson } from '../util/fs';
import { log } from '../util/log';
import { runPool } from '../util/pool';
import { mulberry32 } from '../util/random';
import { classify, countBy, countResults, gapCategory, isFailure, perLayer } from './classifier';
import { runPlaywright, testKey } from './executor';
import { generateMutants } from './generator';
import { createSandbox, removeSandbox, Sandbox } from './sandbox';

export const VERSION = '0.1.0';

/**
 * Mutation Engine (thesis Sec. 4.2 and execution model of Sec. 4.5):
 *   1. trace collection   2. PWE extraction   3. mutant generation
 *   4. mutant execution   5. result aggregation   6. report generation
 */
export class MutationEngine {
  private baseSandbox: Sandbox | null = null;
  private server: ChildProcess | null = null;

  constructor(readonly cfg: ResolvedConfig) {}

  get paths() {
    const out = this.cfg.abs.outputDir;
    return {
      trace: path.join(out, 'trace.json'),
      pwe: path.join(out, `pwe-${this.cfg.maxPwe}.json`),
      mutants: path.join(out, `mutants-pwe${this.cfg.maxPwe}.json`),
      report: path.join(out, `report-pwe${this.cfg.maxPwe}.json`),
      html: path.join(out, `report-pwe${this.cfg.maxPwe}.html`),
      traceRaw: path.join(out, 'trace-raw'),
    };
  }

  /* --------------------------------------------------------- app server */

  async startServer(): Promise<void> {
    const s = this.cfg.server;
    if (!s) return;
    if (await isUp(s.url)) {
      log.info(`server already running at ${s.url}`);
      return;
    }
    log.info(`starting server: ${s.command}`);
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

  private base(): Sandbox {
    if (!this.baseSandbox) this.baseSandbox = createSandbox(this.cfg, 'base');
    return this.baseSandbox;
  }

  cleanup(): void {
    if (this.baseSandbox && !this.cfg.keepSandboxes) removeSandbox(this.baseSandbox);
    this.baseSandbox = null;
    if (!this.cfg.keepSandboxes) {
      const dir = path.join(this.cfg.abs.root, '.mutants');
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) rmrf(dir);
    }
  }

  /* --------------------------------------------- step 1: trace + baseline */

  async trace(): Promise<SuiteTrace> {
    const sandbox = this.base();
    log.info('baseline run (no mutation)...');
    const baselineRun = await runPlaywright(this.cfg, {
      sandbox, files: [], env: { MLMT_MODE: 'off' }, workers: this.cfg.workers, timeoutMs: this.cfg.mutantTimeoutMs * 4, runId: 'baseline',
    });
    if (!baselineRun.reportFound) throw new Error(`baseline run produced no report:\n${baselineRun.stderr}`);
    const baseline: BaselineResult = {
      durationMs: baselineRun.durationMs,
      passed: baselineRun.tests.filter((t) => t.status === 'expected').map(testKey),
      failed: baselineRun.tests.filter((t) => isFailure(t)).map(testKey),
      ok: baselineRun.tests.length > 0 && baselineRun.tests.every((t) => !isFailure(t)),
    };
    log.info(`baseline: ${baseline.passed.length} passed, ${baseline.failed.length} failed in ${(baseline.durationMs / 1000).toFixed(1)}s`);
    if (!baseline.ok) {
      log.warn('baseline is not green; failing tests are ignored when classifying mutants:');
      baseline.failed.forEach((f) => log.warn('  ' + f));
    }

    log.info('trace run (recording interactions, DOM snapshots and network)...');
    rmrf(this.paths.traceRaw);
    ensureDir(this.paths.traceRaw);
    await runPlaywright(this.cfg, {
      sandbox, files: [], env: { MLMT_MODE: 'trace', MLMT_OUT_DIR: this.paths.traceRaw }, workers: this.cfg.workers,
      timeoutMs: this.cfg.mutantTimeoutMs * 4, runId: 'trace',
    });
    const tests: TestTrace[] = fs
      .readdirSync(this.paths.traceRaw)
      .filter((f) => f.startsWith('trace-'))
      .sort()
      .map((f) => readJson<TestTrace>(path.join(this.paths.traceRaw, f)));
    const trace: SuiteTrace = { createdAt: new Date().toISOString(), baseline, tests };
    writeJson(this.paths.trace, trace);
    const pages = new Set(tests.flatMap((t) => Object.keys(t.snapshots)));
    log.info(`trace: ${tests.length} test(s), ${pages.size} page(s), ${tests.reduce((n, t) => n + t.interactions.length, 0)} interaction(s), ${tests.reduce((n, t) => n + t.network.length, 0)} response(s)`);
    return trace;
  }

  loadOrTrace = async (reuse: boolean): Promise<SuiteTrace> => {
    if (reuse && fs.existsSync(this.paths.trace)) {
      log.info(`reusing trace ${this.paths.trace}`);
      return readJson<SuiteTrace>(this.paths.trace);
    }
    return this.trace();
  };

  /* ------------------------------------------------ steps 2-3: PWE + gen */

  pwe(trace: SuiteTrace): PwePage[] {
    const model = buildPweModel(trace, this.cfg.maxPwe);
    writeJson(this.paths.pwe, model);
    log.info(`PWE (top ${this.cfg.maxPwe}/page): ${model.reduce((n, p) => n + p.selected.length, 0)} element(s) on ${model.length} page(s)`);
    return model;
  }

  generate(trace: SuiteTrace, pwe: PwePage[]): MutantDescriptor[] {
    let mutants = generateMutants(this.cfg, pwe, trace);
    if (this.cfg.maxMutants > 0 && mutants.length > this.cfg.maxMutants) {
      const rand = mulberry32(this.cfg.seed);
      mutants = mutants
        .map((m) => ({ m, k: rand() }))
        .sort((a, b) => a.k - b.k)
        .slice(0, this.cfg.maxMutants)
        .map((x) => x.m)
        .sort((a, b) => a.id.localeCompare(b.id));
      log.info(`sampled ${mutants.length} mutants (maxMutants)`);
    }
    writeJson(this.paths.mutants, mutants);
    const by = (l: string) => mutants.filter((m) => m.layer === l).length;
    log.info(`generated ${mutants.length} mutants (dom ${by('dom')}, network ${by('network')}, test ${by('test')})`);
    return mutants;
  }

  /* ------------------------------------------------- step 4: execution */

  async executeOne(m: MutantDescriptor, baselinePassed: Set<string>): Promise<MutantResult> {
    if (m.precheckFailed) {
      return { mutant: m, status: 'SKIPPED', applied: false, applications: 0, durationMs: 0, tests: [], reason: m.precheckFailed };
    }
    const runDir = path.join(this.cfg.abs.outputDir, 'runs', m.id);
    rmrf(runDir);
    const appliedDir = path.join(runDir, 'applied');
    ensureDir(appliedDir);
    const mutantFile = path.join(runDir, 'mutant.json');
    writeJson(mutantFile, m);

    let sandbox: Sandbox;
    let ownSandbox = false;
    if (m.layer === 'test' && m.target.kind === 'test') {
      const src = fs.readFileSync(path.join(this.cfg.abs.testDir, m.target.file), 'utf8');
      const mutated = mutateSource(m.operator, m.target.file, src, m.target.site, m.params);
      sandbox = createSandbox(this.cfg, m.id, { [m.target.file]: mutated });
      fs.writeFileSync(path.join(runDir, 'mutated-' + path.basename(m.target.file)), mutated);
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
    const { status, reason } = classify(m, run, baselinePassed, applications);
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

  async execute(mutants: MutantDescriptor[], baseline: BaselineResult): Promise<MutantResult[]> {
    const baselinePassed = new Set(baseline.passed);
    let done = 0;
    const total = mutants.length;
    return runPool(mutants, this.cfg.workers, async (m) => {
      const r = await this.executeOne(m, baselinePassed);
      done++;
      log.info(`[${done}/${total}] ${m.id} ${m.operator.padEnd(28)} ${r.status.padEnd(8)} ${(r.durationMs / 1000).toFixed(1)}s  ${m.target.description.slice(0, 80)}`);
      return r;
    });
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

  /** Full pipeline. */
  async run(opts: { reuseTrace?: boolean } = {}): Promise<RunReport> {
    const startedAt = new Date();
    try {
      await this.startServer();
      const trace = await this.loadOrTrace(!!opts.reuseTrace);
      const pwe = this.pwe(trace);
      const mutants = this.generate(trace, pwe);
      const t0 = Date.now();
      const results = await this.execute(mutants, trace.baseline);
      const report = this.buildReport(results, pwe, trace, startedAt, Date.now() - t0);
      writeJson(this.paths.report, report);
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
