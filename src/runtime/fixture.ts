/**
 * MultilayerMT runtime fixture (`multilayer-mt/fixture`).
 *
 * The sandboxed copy of a test suite imports this module instead of
 * `@playwright/test` (see engine/sandbox.ts). It re-exports everything from the
 * project's own `@playwright/test` and overrides the `context` fixture:
 *
 *   MLMT_MODE=trace   record interactions, DOM snapshots and network traffic
 *   MLMT_MODE=mutant  register the DOM / network mutation of one mutant
 *   otherwise         behave exactly like `@playwright/test`
 *
 * It can also be imported directly by a suite (`import { test } from
 * 'multilayer-mt/fixture'`) to make the suite permanently MultilayerMT-aware.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import type { BrowserContext, TestInfo } from '@playwright/test';
import { registry } from '../operators/registry';
import type { MutantDescriptor } from '../types';
import type { KeyNormalizer, PageKeyQuery } from '../util/pageKey';
import { hash32 } from '../util/random';
import { applyMutant, attachRecorder } from './instrument';

const projectRoot = process.env.MLMT_PROJECT_ROOT || process.cwd();
const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
// Use the project's own @playwright/test so that only one copy is loaded.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pw = projectRequire('@playwright/test');

const MODE = process.env.MLMT_MODE || 'off';
const OUT_DIR = process.env.MLMT_OUT_DIR || '';
const TEST_DIR = process.env.MLMT_TEST_DIR || '';
const PAGE_KEY_QUERY: PageKeyQuery = process.env.MLMT_PAGE_KEY_QUERY ? JSON.parse(process.env.MLMT_PAGE_KEY_QUERY) : 'all';
const PAGE_KEY_NORMALIZE: KeyNormalizer | undefined = process.env.MLMT_PAGE_KEY_NORMALIZE ? JSON.parse(process.env.MLMT_PAGE_KEY_NORMALIZE) : undefined;
const NET_TYPES: string[] = process.env.MLMT_NET_TYPES ? JSON.parse(process.env.MLMT_NET_TYPES) : ['xhr', 'fetch', 'document'];
const MAX_ELEMENTS = Number(process.env.MLMT_MAX_ELEMENTS || 3000);
const SEED = Number(process.env.MLMT_SEED || 42);
const PLUGINS: string[] = process.env.MLMT_PLUGINS ? JSON.parse(process.env.MLMT_PLUGINS) : [];

let mutant: MutantDescriptor | null = null;
if (MODE === 'mutant' && process.env.MLMT_MUTANT_FILE) {
  mutant = JSON.parse(fs.readFileSync(process.env.MLMT_MUTANT_FILE, 'utf8'));
}

function relTestFile(testInfo: TestInfo): string {
  return TEST_DIR ? path.relative(TEST_DIR, testInfo.file).split(path.sep).join('/') : testInfo.file;
}

function outFile(prefix: string, testInfo: TestInfo): string {
  const id = hash32(`${testInfo.file}|${testInfo.titlePath.join('>')}|${testInfo.repeatEachIndex}|${testInfo.retry}`);
  return path.join(OUT_DIR, `${prefix}-${id.toString(16)}-${testInfo.workerIndex}.json`);
}

async function setup(context: BrowserContext, testInfo: TestInfo): Promise<(() => Promise<void>) | null> {
  if (!OUT_DIR) return null;
  if (MODE === 'trace') {
    const rec = await attachRecorder(context, { pageKeyQuery: PAGE_KEY_QUERY, pageKeyNormalize: PAGE_KEY_NORMALIZE, resourceTypes: NET_TYPES, maxElementsPerSnapshot: MAX_ELEMENTS });
    return async () => {
      const trace = await rec.stop({ testFile: relTestFile(testInfo), testTitle: testInfo.titlePath.slice(1).join(' > '), status: testInfo.status || 'unknown' });
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(outFile('trace', testInfo), JSON.stringify(trace));
    };
  }
  if (MODE === 'mutant' && mutant && mutant.layer !== 'test') {
    await registry.loadPlugins(PLUGINS);
    const handle = await applyMutant(context, mutant, { pageKeyQuery: PAGE_KEY_QUERY, pageKeyNormalize: PAGE_KEY_NORMALIZE, seed: SEED });
    return async () => {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(
        outFile('applied', testInfo),
        JSON.stringify({ test: testInfo.titlePath.slice(1).join(' > '), file: relTestFile(testInfo), applied: handle.applied() }),
      );
    };
  }
  return null;
}

const test = pw.test.extend({
  context: async ({ context }: { context: BrowserContext }, use: (c: BrowserContext) => Promise<void>, testInfo: TestInfo) => {
    const finish = await setup(context, testInfo);
    await use(context);
    if (finish) {
      try {
        await finish();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[mlmt] fixture teardown failed', e);
      }
    }
  },
});

const exported = { ...pw, test, default: test };
export = exported;
