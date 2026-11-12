import * as fs from 'fs';
import * as path from 'path';
import type { Layer } from './types';
import type { PageKeyQuery } from './util/pageKey';

export interface MlmtConfig {
  /** Name of the application under test (used in reports). */
  app: string;
  /** Project root containing node_modules/@playwright/test. */
  projectRoot: string;
  /** Path to the Playwright config of the project (relative to projectRoot). */
  playwrightConfig: string;
  /** Test directory (relative to projectRoot) that is copied into the sandbox. */
  testDir: string;
  /** Only files matching this regex are considered test files for the test-script layer. */
  testFilePattern: string;
  /** Top-N PWEs per page (thesis default 100; study used 4/8/16). */
  maxPwe: number;
  /** Concurrent mutant executions (thesis: 4). */
  workers: number;
  layers: Layer[];
  operators: { include?: string[]; exclude?: string[] };
  /** Per-operator parameter overrides. */
  operatorParams: Record<string, Record<string, unknown>>;
  /** Which query parameters identify a page. */
  pageKeyQuery: PageKeyQuery;
  network: {
    /** Playwright resource types whose requests are network-mutation targets. */
    resourceTypes: string[];
    /** Regex: only endpoints matching are mutated. */
    include?: string;
    /** Regex: endpoints matching are ignored. */
    exclude?: string;
  };
  test: {
    /** Max mutants per (file, operator); additional sites are ignored. */
    maxSitesPerOperator: number;
  };
  /**
   * `covering`: run only the test files that exercised the mutated page/endpoint
   * during tracing (tests that never reach the target cannot kill the mutant).
   * `all`: always run the full suite.
   */
  testSelection: 'covering' | 'all';
  /** Hard timeout for one mutant execution (whole Playwright run). */
  mutantTimeoutMs: number;
  /** Extra CLI args for `playwright test` (e.g. ["--project=chromium"]). */
  playwrightArgs: string[];
  /** Keep the `webServer` entry of the Playwright config for mutant runs. */
  keepWebServer: boolean;
  /** Optional server started by MultilayerMT before tracing and stopped at the end. */
  server?: { command: string; url: string; cwd?: string; timeoutMs?: number };
  /** Output directory (relative to projectRoot). */
  outputDir: string;
  seed: number;
  maxElementsPerSnapshot: number;
  /** Limit the number of executed mutants (sampling, 0 = no limit). */
  maxMutants: number;
  /** Keep sandbox directories after the run (debugging). */
  keepSandboxes: boolean;
}

export const DEFAULT_CONFIG: MlmtConfig = {
  app: 'app',
  projectRoot: '.',
  playwrightConfig: 'playwright.config.ts',
  testDir: 'tests',
  testFilePattern: '\\.(spec|test)\\.(c|m)?(j|t)sx?$',
  maxPwe: 100,
  workers: 4,
  layers: ['dom', 'network', 'test'],
  operators: {},
  operatorParams: {},
  pageKeyQuery: 'all',
  network: { resourceTypes: ['xhr', 'fetch', 'document'] },
  test: { maxSitesPerOperator: 5 },
  testSelection: 'covering',
  mutantTimeoutMs: 5 * 60_000,
  playwrightArgs: [],
  keepWebServer: false,
  outputDir: '.mlmt',
  seed: 42,
  maxElementsPerSnapshot: 3000,
  maxMutants: 0,
  keepSandboxes: false,
};

export interface ResolvedConfig extends MlmtConfig {
  /** absolute paths */
  abs: { root: string; playwrightConfig: string; testDir: string; outputDir: string; configFile?: string };
}

export function loadConfig(file?: string, overrides: Partial<MlmtConfig> = {}): ResolvedConfig {
  let user: Partial<MlmtConfig> = {};
  let baseDir = process.cwd();
  if (file) {
    const abs = path.resolve(file);
    user = JSON.parse(fs.readFileSync(abs, 'utf8'));
    baseDir = path.dirname(abs);
  }
  const cfg: MlmtConfig = {
    ...DEFAULT_CONFIG,
    ...user,
    ...overrides,
    network: { ...DEFAULT_CONFIG.network, ...(user.network || {}), ...(overrides.network || {}) },
    test: { ...DEFAULT_CONFIG.test, ...(user.test || {}), ...(overrides.test || {}) },
    operators: { ...(user.operators || {}), ...(overrides.operators || {}) },
  };
  const root = path.resolve(baseDir, cfg.projectRoot);
  return {
    ...cfg,
    abs: {
      root,
      playwrightConfig: path.resolve(root, cfg.playwrightConfig),
      testDir: path.resolve(root, cfg.testDir),
      outputDir: path.resolve(root, cfg.outputDir),
      configFile: file ? path.resolve(file) : undefined,
    },
  };
}
