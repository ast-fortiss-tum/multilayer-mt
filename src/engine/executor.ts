import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import type { ResolvedConfig } from '../config';
import type { TestOutcome } from '../types';
import type { Sandbox } from './sandbox';
import { ensureDir } from '../util/fs';
import { Logger, silentLogger } from '../util/log';

/**
 * Test Executor (thesis Sec. 4.2): runs the Playwright test runner on a sandbox
 * and captures outcomes, execution time and error messages.
 */

export interface RunOptions {
  sandbox: Sandbox;
  /** test files relative to the test directory; empty = all */
  files: string[];
  env: Record<string, string>;
  workers: number;
  timeoutMs: number;
  /** unique run id (output folders) */
  runId: string;
  signal?: AbortSignal;
  logger?: Logger;
}

export interface RunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  tests: TestOutcome[];
  /** global errors reported by Playwright (config/compile errors, crashes) */
  errors: string[];
  reportFound: boolean;
  stderr: string;
  aborted?: boolean;
}

function playwrightCli(root: string): string {
  const req = createRequire(path.join(root, 'package.json'));
  try {
    return req.resolve('@playwright/test/cli');
  } catch {
    return path.join(path.dirname(req.resolve('@playwright/test/package.json')), 'cli.js');
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Flatten the JSON reporter output. */
export function parseJsonReport(report: any, testDir: string): { tests: TestOutcome[]; errors: string[] } {
  const tests: TestOutcome[] = [];
  const walkSuite = (suite: any, titles: string[]) => {
    const t = suite.title && !/\.(c|m)?(j|t)sx?$/.test(suite.title) ? [...titles, suite.title] : titles;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const results = test.results || [];
        const last = results[results.length - 1] || {};
        const err = last.error?.message || (last.errors && last.errors[0]?.message) || undefined;
        const file = spec.file || suite.file || '';
        tests.push({
          title: [test.projectName || '', ...t, spec.title].filter(Boolean).join(' > '),
          file: path.isAbsolute(file) ? path.relative(testDir, file).split(path.sep).join('/') : file.split(path.sep).join('/'),
          status: test.status || last.status || 'unknown',
          error: err ? String(err).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2000) : undefined,
        });
      }
    }
    for (const s of suite.suites || []) walkSuite(s, t);
  };
  for (const s of report.suites || []) walkSuite(s, []);
  const errors = (report.errors || []).map((e: any) => String(e.message || e.value || e).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2000));
  return { tests, errors };
}

export function testKey(t: TestOutcome): string {
  return `${t.file} :: ${t.title}`;
}

export async function runPlaywright(cfg: ResolvedConfig, opts: RunOptions): Promise<RunOutcome> {
  const runDir = path.join(cfg.abs.outputDir, 'runs', opts.runId);
  ensureDir(runDir);
  const reportFile = path.join(runDir, 'report.json');
  if (fs.existsSync(reportFile)) fs.rmSync(reportFile);

  const args = [
    playwrightCli(cfg.abs.root),
    'test',
    '--config',
    opts.sandbox.configFile,
    '--reporter=json',
    `--workers=${opts.workers}`,
    '--retries=0',
    ...cfg.playwrightArgs,
    ...opts.files.map((f) => escapeRegex(path.join(opts.sandbox.testDir, f).split(path.sep).join('/')) + '$'),
  ];
  const env = {
    ...process.env,
    ...opts.env,
    PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
    MLMT_PW_OUTPUT_DIR: path.join(runDir, 'test-results'),
    MLMT_PROJECT_ROOT: cfg.abs.root,
    MLMT_TEST_DIR: opts.sandbox.testDir,
    MLMT_PAGE_KEY_QUERY: JSON.stringify(cfg.pageKeyQuery),
    ...(cfg.pageKeyNormalize ? { MLMT_PAGE_KEY_NORMALIZE: JSON.stringify(cfg.pageKeyNormalize) } : {}),
    MLMT_NET_TYPES: JSON.stringify(cfg.network.resourceTypes),
    MLMT_MAX_ELEMENTS: String(cfg.maxElementsPerSnapshot),
    MLMT_SEED: String(cfg.seed),
    MLMT_PLUGINS: JSON.stringify(cfg.abs.plugins),
    FORCE_COLOR: '0',
  };
  (opts.logger || silentLogger).debug('spawn', process.execPath, args.join(' '));

  const started = Date.now();
  return await new Promise<RunOutcome>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: cfg.abs.root, env, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      if (stderr.length < 20_000) stderr += d.toString();
    });
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - started;
      let tests: TestOutcome[] = [];
      let errors: string[] = [];
      let reportFound = false;
      if (fs.existsSync(reportFile)) {
        try {
          const parsed = parseJsonReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')), opts.sandbox.testDir);
          tests = parsed.tests;
          errors = parsed.errors;
          reportFound = true;
        } catch (e) {
          errors = [`could not parse JSON report: ${(e as Error).message}`];
        }
      }
      resolve({ exitCode: code, timedOut, durationMs, tests, errors, reportFound, stderr, aborted });
    });
  });
}
