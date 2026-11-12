/**
 * MultilayerMT runtime fixture.
 *
 * The sandboxed copy of the user's test suite imports this module instead of
 * `@playwright/test` (see engine/sandbox.ts). It re-exports everything from the
 * project's own `@playwright/test` and overrides the `context` fixture to:
 *
 *   - `MLMT_MODE=trace`  : record interactions, DOM snapshots and network traffic
 *                          (input of the PWE selector, thesis Sec. 4.3 / 4.5 step 1)
 *   - `MLMT_MODE=mutant` : register the DOM / network mutation of one mutant
 *                          through Playwright hooks (addInitScript, route)
 *   - otherwise          : behave exactly like `@playwright/test`
 */
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import type { BrowserContext, TestInfo } from '@playwright/test';
import { mlmtDomMutator, DomMutationSpec } from '../browser/domMutator';
import { mlmtRecorder } from '../browser/recorder';
import { installNetworkMutation, installResourceFailure } from '../operators/network/runtime';
import type { ElementInfo, InteractionRecord, JsonShape, MutantDescriptor, NetworkRecord, ResourceRecord, TestTrace } from '../types';
import { pageKeyOf, PageKeyQuery } from '../util/pageKey';
import { hash32 } from '../util/random';

const projectRoot = process.env.MLMT_PROJECT_ROOT || process.cwd();
const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pw = projectRequire('@playwright/test');

const MODE = process.env.MLMT_MODE || 'off';
const OUT_DIR = process.env.MLMT_OUT_DIR || '';
const TEST_DIR = process.env.MLMT_TEST_DIR || '';
const PAGE_KEY_QUERY: PageKeyQuery = process.env.MLMT_PAGE_KEY_QUERY ? JSON.parse(process.env.MLMT_PAGE_KEY_QUERY) : 'all';
const NET_TYPES: string[] = process.env.MLMT_NET_TYPES ? JSON.parse(process.env.MLMT_NET_TYPES) : ['xhr', 'fetch', 'document'];
const MAX_ELEMENTS = Number(process.env.MLMT_MAX_ELEMENTS || 3000);
const SEED = Number(process.env.MLMT_SEED || 42);

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

function shapeOf(json: unknown): JsonShape {
  const shape: JsonShape = { fields: {}, samples: {}, hasArray: false, maxArrayLength: 0 };
  const walk = (v: unknown, depth: number) => {
    if (depth > 5) return;
    if (Array.isArray(v)) {
      shape.hasArray = true;
      shape.maxArrayLength = Math.max(shape.maxArrayLength, v.length);
      v.slice(0, 20).forEach((x) => walk(x, depth + 1));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const t = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
        const prev = shape.fields[k];
        shape.fields[k] = prev && !prev.split('|').includes(t) ? `${prev}|${t}` : prev || t;
        if (!(k in shape.samples) && (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')) {
          shape.samples[k] = typeof val === 'string' ? val.slice(0, 60) : val;
        }
        walk(val, depth + 1);
      }
    }
  };
  walk(json, 0);
  return shape;
}

/* ------------------------------------------------------------------ trace */

async function setupTrace(context: BrowserContext, testInfo: TestInfo): Promise<() => Promise<void>> {
  const snapshots: Record<string, Record<string, ElementInfo>> = {};
  const interactions: InteractionRecord[] = [];
  const network: NetworkRecord[] = [];
  const resources: ResourceRecord[] = [];
  const pending: Promise<unknown>[] = [];

  const mergeElement = (pageKey: string, el: ElementInfo) => {
    const page = (snapshots[pageKey] ||= {});
    const prev = page[el.selector];
    if (prev) {
      // a PWE is visible if it was visible in any snapshot
      el.visibility = {
        inViewport: prev.visibility.inViewport || el.visibility.inViewport,
        displayed: prev.visibility.displayed || el.visibility.displayed,
        opaque: prev.visibility.opaque || el.visibility.opaque,
        nonZeroSize: prev.visibility.nonZeroSize || el.visibility.nonZeroSize,
      };
    }
    page[el.selector] = el;
  };

  await context.exposeBinding('__mlmtRecord', (_source, msg: { kind: string; payload: any }) => {
    const { kind, payload } = msg || ({} as any);
    if (kind === 'snapshot') {
      for (const el of payload.elements as ElementInfo[]) mergeElement(payload.pageKey, el);
    } else if (kind === 'interaction') {
      interactions.push({ kind: payload.kind, pageKey: payload.pageKey, selector: payload.selector });
      if (payload.element) mergeElement(payload.pageKey, payload.element);
    } else if (kind === 'resources') {
      for (const r of payload.resources) {
        if (!resources.some((x) => x.url === r.url && x.pageKey === payload.pageKey)) {
          resources.push({ pageKey: payload.pageKey, kind: r.kind, url: r.url });
        }
      }
    }
  });
  await context.addInitScript({
    content: `(${mlmtRecorder.toString()})(${JSON.stringify({ pageKeyQuery: PAGE_KEY_QUERY, maxElements: MAX_ELEMENTS })});`,
  });

  context.on('response', (response) => {
    const req = response.request();
    const rt = req.resourceType();
    if (!NET_TYPES.includes(rt)) return;
    const work = (async () => {
      let frameUrl = '';
      try {
        frameUrl = req.frame().page()?.url() || req.frame().url();
      } catch {
        frameUrl = '';
      }
      const url = req.url();
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return;
      }
      if (!/^https?:$/.test(u.protocol)) return;
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      const rec: NetworkRecord = {
        pageKey: frameUrl && /^https?:/.test(frameUrl) ? pageKeyOf(frameUrl, PAGE_KEY_QUERY) : pageKeyOf(url, PAGE_KEY_QUERY),
        method: req.method(),
        url,
        endpoint: `${req.method()} ${u.origin}${u.pathname}`,
        resourceType: rt,
        status: response.status(),
        contentType,
      };
      if (/json/i.test(contentType)) {
        try {
          rec.json = shapeOf(JSON.parse((await response.body()).toString('utf8')));
        } catch {
          /* body not available (redirect, aborted) */
        }
      }
      network.push(rec);
    })();
    pending.push(work.catch(() => undefined));
  });

  return async () => {
    await Promise.all(pending);
    const trace: TestTrace = {
      testFile: relTestFile(testInfo),
      testTitle: testInfo.titlePath.slice(1).join(' > '),
      status: testInfo.status || 'unknown',
      snapshots,
      interactions,
      network,
      resources,
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(outFile('trace', testInfo), JSON.stringify(trace));
  };
}

/* ----------------------------------------------------------------- mutant */

async function setupMutant(context: BrowserContext, testInfo: TestInfo, m: MutantDescriptor): Promise<() => Promise<void>> {
  const applied: string[] = [];
  const onApplied = (d: string) => {
    if (applied.length < 50) applied.push(d);
    else applied[49] = `${d} (+more)`;
  };

  if (m.layer === 'dom' && m.target.kind === 'dom') {
    await context.exposeBinding('__mlmtApplied', (_s, info: { detail: string }) => onApplied(info?.detail || m.operator));
    const spec: DomMutationSpec = {
      operator: m.operator,
      pageKey: m.target.pageKey,
      pageKeyQuery: PAGE_KEY_QUERY,
      selector: m.target.selector,
      resourceUrl: m.target.resourceUrl,
      params: m.params,
      seed: hash32(m.id) ^ SEED,
    };
    await context.addInitScript({ content: `(${mlmtDomMutator.toString()})(${JSON.stringify(spec)});` });
    if (m.operator === 'SFM.script.fail' || m.operator === 'SFM.stylesheet.fail') {
      await installResourceFailure(context, m.target.resourceUrl, m.operator === 'SFM.script.fail' ? 'script' : 'stylesheet', onApplied);
    }
  } else if (m.layer === 'network') {
    await installNetworkMutation(context, m, onApplied, hash32(m.id) ^ SEED);
  }

  return async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(
      outFile('applied', testInfo),
      JSON.stringify({ test: testInfo.titlePath.slice(1).join(' > '), file: relTestFile(testInfo), applied }),
    );
  };
}

/* ---------------------------------------------------------------- fixture */

const test = pw.test.extend({
  context: async ({ context }: { context: BrowserContext }, use: (c: BrowserContext) => Promise<void>, testInfo: TestInfo) => {
    let finish: (() => Promise<void>) | null = null;
    if (MODE === 'trace' && OUT_DIR) finish = await setupTrace(context, testInfo);
    else if (MODE === 'mutant' && mutant && OUT_DIR) finish = await setupMutant(context, testInfo, mutant);
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
