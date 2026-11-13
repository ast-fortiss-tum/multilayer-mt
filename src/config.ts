import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Layer } from './types';
import type { KeyNormalizer, PageKeyQuery } from './util/pageKey';

/** A reporter: built-in name, module path, or (programmatic use) a function. */
export type ReporterSpec = 'json' | 'html' | 'markdown' | 'console' | string | ReporterFn | [string, Record<string, unknown>];
export type ReporterFn = (report: import('./types').RunReport, ctx: { outputDir: string; config: ResolvedConfig }) => void | Promise<void>;

export interface MlmtConfig {
  /** Name of the application under test (used in reports). */
  app: string;
  /** Project root containing node_modules/@playwright/test. Relative to the config file (or cwd). */
  projectRoot: string;
  /** Path to the Playwright config of the project (relative to projectRoot). */
  playwrightConfig: string;
  /** Test directory (relative to projectRoot) that is copied into the sandbox. */
  testDir: string;
  /** Regex: files considered test files for the test-script layer. */
  testFilePattern: string;
  /** Top-N PWEs per page (thesis default 100; the study used 4/8/16). */
  maxPwe: number;
  /** Concurrent mutant executions (thesis: 4). */
  workers: number;
  /** Playwright workers for the baseline and trace runs (default: `workers`). */
  baselineWorkers?: number;
  layers: Layer[];
  /** Operator ids or family prefixes (e.g. "SVM", "NSO.status.override"). */
  /**
   * Built-in operators to use: the 51 thesis operators, the literature library
   * (docs/OPERATORS.md), or both. Plugin operators are always available.
   */
  operatorSet: 'thesis' | 'literature' | 'all';
  operators: { include?: string[]; exclude?: string[] };
  /** Per-operator parameter overrides. */
  operatorParams: Record<string, Record<string, unknown>>;
  /** Plugin modules with custom operators (paths relative to projectRoot). */
  plugins: string[];
  /** Reporters run at the end of `run`. */
  reporters: ReporterSpec[];
  /** Which query parameters identify a page ('all', 'none' or a list). */
  pageKeyQuery: PageKeyQuery;
  /**
   * Regex rewrites `[pattern, replacement]` applied to page keys and network
   * endpoints, for URLs that embed run-specific ids (e.g. generated page titles).
   */
  pageKeyNormalize?: KeyNormalizer;
  network: {
    /** Playwright resource types whose requests are network-mutation targets. */
    resourceTypes: string[];
    /** Regex: only endpoints (`METHOD url`) matching are mutated. */
    include?: string;
    /** Regex: endpoints matching are ignored. */
    exclude?: string;
    /** Mutate endpoints on other origins than the application pages. */
    thirdParty?: boolean;
  };
  test: {
    /** Max mutants per (file, operator); further sites are ignored. */
    maxSitesPerOperator: number;
  };
  /** `covering`: only tests that reached the mutated page/endpoint; `all`: whole suite. */
  testSelection: 'covering' | 'all';
  /** Hard timeout for one mutant execution (whole Playwright run). */
  mutantTimeoutMs: number;
  /** Extra CLI args for `playwright test` (e.g. ["--project=chromium"]). */
  playwrightArgs: string[];
  /** Keep the `webServer` entry of the Playwright config for mutant runs. */
  keepWebServer: boolean;
  /** Optional server started before tracing and stopped at the end. */
  server?: { command: string; url: string; cwd?: string; timeoutMs?: number };
  /** Output directory (relative to projectRoot). */
  outputDir: string;
  /** Sandbox directory (relative to projectRoot; must be inside it for module resolution). */
  sandboxDir: string;
  seed: number;
  maxElementsPerSnapshot: number;
  /** Execute a seeded random sample of this many mutants (0 = all). */
  maxMutants: number;
  /** Keep sandbox directories after the run (debugging). */
  keepSandboxes: boolean;
  /** Abort if the baseline has failing tests (otherwise they are ignored). */
  requireGreenBaseline: boolean;
}

export type UserConfig = Partial<Omit<MlmtConfig, 'network' | 'test'>> & {
  network?: Partial<MlmtConfig['network']>;
  test?: Partial<MlmtConfig['test']>;
};

export const DEFAULT_CONFIG: MlmtConfig = {
  app: 'app',
  projectRoot: '.',
  playwrightConfig: 'playwright.config.ts',
  testDir: 'tests',
  testFilePattern: '\\.(spec|test)\\.(c|m)?(j|t)sx?$',
  maxPwe: 100,
  operatorSet: 'all',
  workers: 4,
  layers: ['dom', 'network', 'test'],
  operators: {},
  operatorParams: {},
  plugins: [],
  reporters: ['json', 'html'],
  pageKeyQuery: 'all',
  network: { resourceTypes: ['xhr', 'fetch', 'document'] },
  test: { maxSitesPerOperator: 5 },
  testSelection: 'covering',
  mutantTimeoutMs: 5 * 60_000,
  playwrightArgs: [],
  keepWebServer: false,
  outputDir: '.mlmt',
  sandboxDir: '.mutants',
  seed: 42,
  maxElementsPerSnapshot: 3000,
  maxMutants: 0,
  keepSandboxes: false,
  requireGreenBaseline: false,
};

export interface ResolvedConfig extends MlmtConfig {
  /** Absolute paths. */
  abs: { root: string; playwrightConfig: string; testDir: string; outputDir: string; sandboxDir: string; plugins: string[]; configFile?: string };
}

/** Identity helper for typed config files (`mlmt.config.js`). */
export function defineConfig(c: UserConfig): UserConfig {
  return c;
}

export const CONFIG_FILES = ['mlmt.config.js', 'mlmt.config.cjs', 'mlmt.config.mjs', 'mlmt.config.json'];

/** Find a config file in `dir`. */
export function findConfigFile(dir = process.cwd()): string | undefined {
  for (const f of CONFIG_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

export async function readConfigFile(file: string): Promise<UserConfig> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new ConfigError(`config file not found: ${abs}`);
  if (abs.endsWith('.json')) {
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      throw new ConfigError(`invalid JSON in ${abs}: ${(e as Error).message}`);
    }
  }
  const mod = abs.endsWith('.mjs') ? await dynamicImport(pathToFileURL(abs).href) : require(abs);
  const cfg = mod?.default ?? mod;
  return typeof cfg === 'function' ? await cfg() : cfg;
}

export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ConfigError';
  }
}

function merge(base: MlmtConfig, ...parts: UserConfig[]): MlmtConfig {
  let out: MlmtConfig = { ...base };
  for (const p of parts) {
    const clean = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as UserConfig;
    out = {
      ...out,
      ...(clean as Partial<MlmtConfig>),
      network: { ...out.network, ...(clean.network || {}) },
      test: { ...out.test, ...(clean.test || {}) },
      operators: { ...out.operators, ...(clean.operators || {}) },
      operatorParams: { ...out.operatorParams, ...(clean.operatorParams || {}) },
    };
  }
  return out;
}

/** Validate a merged config; throws ConfigError listing every problem. */
export function validateConfig(c: MlmtConfig): void {
  const errs: string[] = [];
  const posInt = (k: keyof MlmtConfig, min = 1) => {
    const v = c[k] as unknown;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) errs.push(`${String(k)} must be an integer >= ${min} (got ${JSON.stringify(v)})`);
  };
  posInt('maxPwe');
  posInt('workers');
  posInt('mutantTimeoutMs', 1000);
  posInt('maxMutants', 0);
  posInt('maxElementsPerSnapshot');
  if (c.baselineWorkers !== undefined) posInt('baselineWorkers');
  if (!Array.isArray(c.layers) || !c.layers.length || c.layers.some((l) => !['dom', 'network', 'test'].includes(l))) {
    errs.push(`layers must be a non-empty subset of ["dom","network","test"] (got ${JSON.stringify(c.layers)})`);
  }
  if (!['covering', 'all'].includes(c.testSelection)) errs.push(`testSelection must be "covering" or "all"`);
  if (!['thesis', 'literature', 'all'].includes(c.operatorSet)) errs.push(`operatorSet must be "thesis", "literature" or "all"`);
  if (!(c.pageKeyQuery === 'all' || c.pageKeyQuery === 'none' || (Array.isArray(c.pageKeyQuery) && c.pageKeyQuery.every((x) => typeof x === 'string')))) {
    errs.push(`pageKeyQuery must be "all", "none" or a list of parameter names`);
  }
  if (c.pageKeyNormalize !== undefined) {
    if (!Array.isArray(c.pageKeyNormalize) || !c.pageKeyNormalize.every((r) => Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'string'))) {
      errs.push('pageKeyNormalize must be a list of [pattern, replacement] string pairs');
    } else {
      for (const [p] of c.pageKeyNormalize) {
        try {
          new RegExp(p);
        } catch {
          errs.push(`pageKeyNormalize: invalid regex ${JSON.stringify(p)}`);
        }
      }
    }
  }
  for (const k of ['testFilePattern'] as const) {
    try {
      new RegExp(c[k]);
    } catch {
      errs.push(`${k} is not a valid regex`);
    }
  }
  for (const k of ['include', 'exclude'] as const) {
    const v = c.network[k];
    if (v !== undefined) {
      try {
        new RegExp(v);
      } catch {
        errs.push(`network.${k} is not a valid regex`);
      }
    }
  }
  if (!Array.isArray(c.reporters)) errs.push('reporters must be an array');
  if (!Array.isArray(c.plugins)) errs.push('plugins must be an array of module paths');
  if (c.server && (!c.server.command || !c.server.url)) errs.push('server needs "command" and "url"');
  if (errs.length) throw new ConfigError(`invalid MultilayerMT config:\n  - ${errs.join('\n  - ')}`);
}

function resolve(cfg: MlmtConfig, baseDir: string, configFile?: string): ResolvedConfig {
  validateConfig(cfg);
  const root = path.resolve(baseDir, cfg.projectRoot);
  const sandboxDir = path.resolve(root, cfg.sandboxDir);
  const abs = {
    root,
    playwrightConfig: path.resolve(root, cfg.playwrightConfig),
    testDir: path.resolve(root, cfg.testDir),
    outputDir: path.resolve(root, cfg.outputDir),
    sandboxDir,
    plugins: cfg.plugins.map((p) => path.resolve(root, p)),
    configFile,
  };
  const rel = path.relative(root, sandboxDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ConfigError('sandboxDir must be inside projectRoot (needed for module resolution)');
  return { ...cfg, abs };
}

/**
 * Resolve a configuration from a file and/or an object (synchronous; JSON and
 * CommonJS config files only).
 */
export function loadConfig(file?: string, overrides: UserConfig = {}): ResolvedConfig {
  let user: UserConfig = {};
  let baseDir = process.cwd();
  if (file) {
    const abs = path.resolve(file);
    if (abs.endsWith('.mjs')) throw new ConfigError('use loadConfigAsync() for .mjs config files');
    user = abs.endsWith('.json') ? JSON.parse(fs.readFileSync(abs, 'utf8')) : (require(abs)?.default ?? require(abs));
    baseDir = path.dirname(abs);
  }
  return resolve(merge(DEFAULT_CONFIG, user, overrides), baseDir, file ? path.resolve(file) : undefined);
}

/**
 * Resolve a configuration.
 * @param source  a config file path, a config object, or undefined (auto-discover in `cwd`)
 * @param overrides values that take precedence (e.g. CLI flags)
 */
export async function loadConfigAsync(source?: string | UserConfig, overrides: UserConfig = {}, cwd = process.cwd()): Promise<ResolvedConfig> {
  if (typeof source === 'object') return resolve(merge(DEFAULT_CONFIG, source, overrides), cwd);
  const file = source ? path.resolve(cwd, source) : findConfigFile(cwd);
  if (!file) return resolve(merge(DEFAULT_CONFIG, overrides), cwd);
  const user = await readConfigFile(file);
  return resolve(merge(DEFAULT_CONFIG, user, overrides), path.dirname(file), file);
}
