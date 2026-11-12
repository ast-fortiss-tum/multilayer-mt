/**
 * Runtime instrumentation of Playwright browser contexts and pages.
 *
 * These are the building blocks used by the test-runner fixture, exposed for
 * direct use by other tools (crawlers, test generators, evaluation harnesses):
 *
 *   - attachRecorder()        record interactions, DOM snapshots and network traffic
 *   - applyDomMutation()      inject one DOM-layer mutation into a page/context
 *   - applyNetworkMutation()  inject one network-layer mutation into a page/context
 *   - applyMutant()           inject a generated MutantDescriptor
 */
import type { BrowserContext, Page } from '@playwright/test';
import { mlmtDomMutator, DomMutationSpec } from '../browser/domMutator';
import { mlmtRecorder } from '../browser/recorder';
import { installNetworkMutation, installResourceFailure } from '../operators/network/runtime';
import { registry, DomOperatorDef } from '../operators/registry';
import type { ElementInfo, InteractionRecord, JsonShape, MutantDescriptor, NetworkRecord, ResourceRecord, TestTrace } from '../types';
import { KeyNormalizer, normalizeKey, pageKeyOf, PageKeyQuery } from '../util/pageKey';
import { hash32 } from '../util/random';

type Target = Page | BrowserContext;

function isPage(t: Target): t is Page {
  return typeof (t as Page).mainFrame === 'function';
}

let bindingCounter = 0;

/* ================================================================ recorder */

export interface RecorderOptions {
  pageKeyQuery?: PageKeyQuery;
  /** Rewrite rules for page keys and endpoints (see KeyNormalizer). */
  pageKeyNormalize?: KeyNormalizer;
  /** Playwright resource types to record (default xhr, fetch, document). */
  resourceTypes?: string[];
  maxElementsPerSnapshot?: number;
}

export interface RecorderHandle {
  /** Flush pending work and return the collected trace. */
  stop(meta?: { testFile?: string; testTitle?: string; status?: string }): Promise<TestTrace>;
}

export function shapeOf(json: unknown): JsonShape {
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

/**
 * Attach the trace recorder to a context (all its pages) or a single page.
 * Must be called before the pages navigate to be recorded.
 *
 * ```ts
 * const rec = await attachRecorder(context);
 * // ... drive the browser (tests, crawler, agent) ...
 * const trace = await rec.stop({ testFile: 'crawl', testTitle: 'session 1' });
 * ```
 */
export async function attachRecorder(target: Target, opts: RecorderOptions = {}): Promise<RecorderHandle> {
  const pageKeyQuery = opts.pageKeyQuery ?? 'all';
  const norm = opts.pageKeyNormalize;
  const resourceTypes = opts.resourceTypes ?? ['xhr', 'fetch', 'document'];
  const snapshots: Record<string, Record<string, ElementInfo>> = {};
  const interactions: InteractionRecord[] = [];
  const network: NetworkRecord[] = [];
  const resources: ResourceRecord[] = [];
  const pending: Promise<unknown>[] = [];
  let stopped = false;

  const mergeElement = (pageKey: string, el: ElementInfo) => {
    const page = (snapshots[pageKey] ||= {});
    const prev = page[el.selector];
    if (prev) {
      // an element counts as visible if it was visible in any snapshot
      el.visibility = {
        inViewport: prev.visibility.inViewport || el.visibility.inViewport,
        displayed: prev.visibility.displayed || el.visibility.displayed,
        opaque: prev.visibility.opaque || el.visibility.opaque,
        nonZeroSize: prev.visibility.nonZeroSize || el.visibility.nonZeroSize,
      };
    }
    page[el.selector] = el;
  };

  await target.exposeBinding('__mlmtRecord', (_source, msg: { kind: string; payload: any }) => {
    if (stopped) return;
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
  await target.addInitScript({
    content: `(${mlmtRecorder.toString()})(${JSON.stringify({ pageKeyQuery, pageKeyNormalize: norm, maxElements: opts.maxElementsPerSnapshot ?? 3000 })});`,
  });

  const onResponse = (response: import('@playwright/test').Response) => {
    if (stopped) return;
    const req = response.request();
    const rt = req.resourceType();
    if (!resourceTypes.includes(rt)) return;
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
        pageKey: frameUrl && /^https?:/.test(frameUrl) ? pageKeyOf(frameUrl, pageKeyQuery, norm) : pageKeyOf(url, pageKeyQuery, norm),
        method: req.method(),
        url,
        endpoint: `${req.method()} ${normalizeKey(u.origin + u.pathname, norm)}`,
        resourceType: rt,
        status: response.status(),
        contentType,
      };
      if (/json/i.test(contentType)) {
        try {
          rec.json = shapeOf(JSON.parse((await response.body()).toString('utf8')));
        } catch {
          /* body unavailable (redirect, aborted) */
        }
      }
      network.push(rec);
    })();
    pending.push(work.catch(() => undefined));
  };
  target.on('response', onResponse);

  return {
    async stop(meta = {}) {
      await Promise.all(pending);
      stopped = true;
      target.off('response', onResponse);
      return {
        testFile: meta.testFile ?? 'session',
        testTitle: meta.testTitle ?? 'session',
        status: meta.status ?? 'passed',
        snapshots,
        interactions,
        network,
        resources,
      };
    },
  };
}

/* =============================================================== mutations */

export interface MutationHandle {
  /** Descriptions of each application (empty = never applied = not applicable). */
  applied(): string[];
}

export interface ApplyOptions {
  pageKeyQuery?: PageKeyQuery;
  pageKeyNormalize?: KeyNormalizer;
  seed?: number;
}

/**
 * Inject a generated mutant (DOM or network layer) into a context or page.
 * Test-script mutants are source transformations and are not handled here
 * (see `mutateTestSource`).
 */
export async function applyMutant(target: Target, mutant: MutantDescriptor, opts: ApplyOptions = {}): Promise<MutationHandle> {
  const applied: string[] = [];
  const onApplied = (d: string) => {
    if (applied.length < 200) applied.push(d);
  };
  const seed = (hash32(mutant.id) ^ (opts.seed ?? 42)) >>> 0;

  if (mutant.layer === 'dom' && mutant.target.kind === 'dom') {
    const def = registry.get(mutant.operator) as DomOperatorDef;
    const name = `__mlmtApplied_${bindingCounter++}`;
    await target.exposeBinding(name, (_s, info: { detail: string }) => onApplied(info?.detail || mutant.operator));
    const spec: DomMutationSpec = {
      operator: mutant.operator,
      pageKey: mutant.target.pageKey,
      pageKeyQuery: opts.pageKeyQuery ?? 'all',
      pageKeyNormalize: opts.pageKeyNormalize,
      selector: mutant.target.selector,
      resourceUrl: mutant.target.resourceUrl,
      params: mutant.params,
      seed,
      scope: def.scope,
      bindingName: name,
    };
    const script = domScript(spec, def);
    await target.addInitScript({ content: script });
    if (mutant.operator === 'SFM.script.fail' || mutant.operator === 'SFM.stylesheet.fail') {
      await installResourceFailure(target as BrowserContext, mutant.target.resourceUrl, mutant.operator === 'SFM.script.fail' ? 'script' : 'stylesheet', onApplied);
    }
    // apply to documents that are already loaded
    const pages = isPage(target) ? [target] : target.pages();
    for (const p of pages) {
      if (p.url().startsWith('http')) await p.evaluate(script).catch(() => undefined);
    }
  } else if (mutant.layer === 'network') {
    await installNetworkMutation(target as BrowserContext, mutant, onApplied, seed, opts.pageKeyNormalize);
  } else {
    throw new Error(`applyMutant: ${mutant.layer}-layer mutants are source transformations; use mutateTestSource()`);
  }
  return { applied: () => [...applied] };
}

function domScript(spec: DomMutationSpec, def: DomOperatorDef): string {
  const custom = def.apply ? normaliseFn(def.apply.toString()) : 'null';
  return `(${mlmtDomMutator.toString()})(${JSON.stringify(spec)}, ${custom});`;
}

/** Method shorthand (`apply(el) {}`) is not a valid expression: turn it into a function expression. */
function normaliseFn(src: string): string {
  if (src === 'null') return src;
  if (/^(async\s+)?function\b/.test(src) || /^(async\s*)?(\([^)]*\)|[\w$]+)\s*=>/.test(src)) return src;
  return `function ${src}`;
}

/**
 * Inject one DOM-layer mutation by operator id.
 *
 * ```ts
 * const h = await applyDomMutation(page, { operator: 'SVM.display.none', selector: '#save' });
 * await page.goto(url);           // also applied to future navigations
 * console.log(h.applied());       // ['css rule injected for 1 element(s)']
 * ```
 * Without `pageKey` the mutation applies on every page.
 */
export async function applyDomMutation(
  target: Target,
  o: { operator: string; selector?: string; pageKey?: string; resourceUrl?: string; params?: Record<string, unknown>; id?: string } & ApplyOptions,
): Promise<MutationHandle> {
  const def = registry.get(o.operator);
  if (def.layer !== 'dom') throw new Error(`${o.operator} is not a DOM-layer operator`);
  if (def.scope === 'element' && !o.selector) throw new Error(`${o.operator} needs a selector`);
  return applyMutant(
    target,
    {
      id: o.id ?? `${o.operator}@${o.selector ?? 'page'}`,
      operator: o.operator,
      layer: 'dom',
      target: { kind: 'dom', pageKey: o.pageKey ?? '*', selector: o.selector, resourceUrl: o.resourceUrl, description: o.selector ?? 'page' },
      params: { ...def.defaults, ...(o.params || {}) },
      testFiles: [],
    },
    o,
  );
}

/**
 * Inject one network-layer mutation by operator id.
 * `url` is matched against origin + pathname (query ignored).
 */
export async function applyNetworkMutation(
  target: Target,
  o: { operator: string; url: string; method?: string; params?: Record<string, unknown>; id?: string } & ApplyOptions,
): Promise<MutationHandle> {
  const def = registry.get(o.operator);
  if (def.layer !== 'network') throw new Error(`${o.operator} is not a network-layer operator`);
  const u = new URL(o.url);
  const method = (o.method || 'GET').toUpperCase();
  return applyMutant(
    target,
    {
      id: o.id ?? `${o.operator}@${method} ${u.origin}${u.pathname}`,
      operator: o.operator,
      layer: 'network',
      target: { kind: 'network', endpoint: `${method} ${u.origin}${u.pathname}`, method, urlBase: u.origin + u.pathname, description: o.url },
      params: { ...def.defaults, ...(o.params || {}) },
      testFiles: [],
    },
    o,
  );
}
