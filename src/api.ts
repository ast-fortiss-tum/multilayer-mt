/**
 * High-level programmatic API.
 *
 * ```ts
 * import { runMutationAnalysis } from 'multilayer-mt';
 *
 * const report = await runMutationAnalysis({
 *   config: { projectRoot: '/path/to/app', testDir: 'e2e', maxPwe: 8, layers: ['dom', 'network'] },
 *   onResult: (r, p) => console.log(`${p.done}/${p.total}`, r.mutant.id, r.status),
 * });
 * console.log(report.totals.mutationScore);
 * ```
 */
import { loadConfigAsync, ResolvedConfig, UserConfig } from './config';
import { EngineOptions, MutationEngine, RunOptions } from './engine/engine';
import { mutateSource, findSites } from './operators/test/astMutator';
import { registry } from './operators/registry';
import type { BaselineResult, MutantResult, RunReport, SuiteTrace, TestTrace } from './types';

export interface AnalysisOptions extends EngineOptions, RunOptions {
  /** Config file path or config object; undefined = discover `mlmt.config.*` in `cwd`. */
  config?: string | UserConfig;
  /** Values overriding the config (e.g. `{ maxPwe: 16 }`). */
  overrides?: UserConfig;
  cwd?: string;
  /** Called after each mutant finishes. */
  onResult?: (result: MutantResult, progress: { done: number; total: number }) => void;
}

/** Resolve the config and create an engine (use for step-by-step control or event subscription). */
export async function createEngine(opts: Omit<AnalysisOptions, keyof RunOptions | 'onResult'> = {}): Promise<MutationEngine> {
  const cfg: ResolvedConfig = await loadConfigAsync(opts.config, opts.overrides ?? {}, opts.cwd);
  const engine = new MutationEngine(cfg, opts);
  await engine.init();
  return engine;
}

/** Run the full MultilayerMT pipeline and return the report. Reporters are disabled unless given. */
export async function runMutationAnalysis(opts: AnalysisOptions = {}): Promise<RunReport> {
  const engine = await createEngine(opts);
  if (opts.onResult) engine.on('mutant:result', opts.onResult);
  return engine.run({
    trace: opts.trace,
    reuseTrace: opts.reuseTrace,
    mutants: opts.mutants,
    reporters: opts.reporters ?? false,
    signal: opts.signal,
  });
}

/**
 * Evaluate a set of (e.g. generated) test files against a running application
 * without writing them into the project. Files are given relative to the
 * project's test directory; existing tests can be excluded with `onlyInline`.
 */
export async function evaluateTestSuite(
  tests: Record<string, string>,
  opts: AnalysisOptions & { onlyInline?: boolean } = {},
): Promise<RunReport> {
  const overrides: UserConfig = { ...(opts.overrides || {}) };
  if (opts.onlyInline) {
    // restrict the test-file pattern to the inline files
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    overrides.testFilePattern = `^(${Object.keys(tests).map(esc).join('|')})$`;
    overrides.playwrightArgs = [...(overrides.playwrightArgs || []), ...Object.keys(tests).map((t) => esc(t) + '$')];
  }
  return runMutationAnalysis({ ...opts, overrides, inlineTests: { ...(opts.inlineTests || {}), ...tests } });
}

/** Build a SuiteTrace from traces recorded with `attachRecorder()` (e.g. by a crawler). */
export function createSuiteTrace(tests: TestTrace[], baseline?: Partial<BaselineResult>): SuiteTrace {
  return {
    createdAt: new Date().toISOString(),
    baseline: { durationMs: 0, passed: [], failed: [], ok: true, ...(baseline || {}) },
    tests,
  };
}

const DEFAULT_PARAMS_FOR = (op: string): Record<string, unknown> => ({ ...registry.get(op).defaults });

export interface TestMutationSite {
  operator: string;
  site: number;
  line: number;
  description: string;
  snippet: string;
}

/**
 * List all test-script mutation sites of a test source (all or the given
 * operators). Useful for test generators that want to self-check their output.
 */
export function listTestMutationSites(source: string, opts: { fileName?: string; operators?: string[]; params?: Record<string, Record<string, unknown>> } = {}): TestMutationSite[] {
  const fileName = opts.fileName ?? 'test.spec.ts';
  const ops = opts.operators ?? registry.list('test').map((o) => o.id);
  const out: TestMutationSite[] = [];
  for (const op of ops) {
    const params = { ...DEFAULT_PARAMS_FOR(op), ...(opts.params?.[op] || {}) };
    findSites(op, fileName, source, params).forEach((s, i) => out.push({ operator: op, site: i, line: s.line, description: s.description, snippet: s.snippet }));
  }
  return out;
}

/** Apply one test-script operator at one site and return the mutated source. */
export function mutateTestSource(source: string, operator: string, opts: { site?: number; fileName?: string; params?: Record<string, unknown> } = {}): string {
  const params = { ...DEFAULT_PARAMS_FOR(operator), ...(opts.params || {}) };
  return mutateSource(operator, opts.fileName ?? 'test.spec.ts', source, opts.site ?? 0, params);
}
