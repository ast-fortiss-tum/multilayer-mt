import * as path from 'path';
import { pathToFileURL } from 'url';
import type * as TS from 'typescript';
import type { BrowserContext, Request, Route } from '@playwright/test';
import type { DomScope, ElementInfo, JsonShape, Layer, OperatorInfo } from '../types';
import { ALL_OPERATORS } from './catalog';
import { LITERATURE_OPERATORS } from './lit';

/**
 * Operator registry and plugin API.
 *
 * The 51 built-in operators are registered at load time. Custom operators for
 * any layer are added with plugins:
 *
 * ```ts
 * // my-operators.js
 * const { definePlugin, defineDomOperator } = require('multilayer-mt');
 * module.exports = definePlugin({
 *   name: 'my-operators',
 *   operators: [
 *     defineDomOperator({
 *       id: 'XAM.title.remove',
 *       category: 'Attribute Mutations',
 *       intent: 'Remove tooltips',
 *       applicable: (el) => 'title' in el.attrs,
 *       // runs in the browser: must be self-contained
 *       apply: (el) => { if (!el.hasAttribute('title')) return null; el.removeAttribute('title'); return 'title removed'; },
 *     }),
 *   ],
 * });
 * ```
 *
 * Plugins are referenced by module path (config `plugins`), because network
 * operators run inside the Playwright worker processes, which load the same
 * plugin files.
 */

/** Helpers passed to a custom DOM operator's `apply` in the browser. */
export interface DomApplyHelpers {
  /** Seeded PRNG in [0, 1). */
  rand: () => number;
  /** Report an application later (e.g. from a patched API when it is called). */
  report: (detail: string) => void;
}

export interface DomOperatorDef extends OperatorInfo {
  layer: 'dom';
  scope: DomScope;
  /**
   * Generation-time pre-check on the recorded element (element scope only).
   * Defaults to `true` for custom operators.
   */
  applicable?: (el: ElementInfo, params: Record<string, any>) => boolean;
  /**
   * Element scope: the operator acts on a whole form, so every control of a
   * form would yield the same mutant; the target is the enclosing form.
   */
  formScoped?: boolean;
  /**
   * Browser-side mutation. Serialised with `toString()` and injected into the
   * page, so it must not reference anything outside its own body. Return a
   * short description when applied, or `null` when not applicable.
   * For `scope: 'page'` it receives `document.documentElement`.
   * Built-in operators leave this undefined (implemented in browser/domMutator).
   */
  apply?: (el: Element, params: Record<string, any>, helpers: DomApplyHelpers) => string | null;
  /**
   * Page scope only. 'ready' (default): `apply` runs once the document is
   * parsed. 'init': `apply` runs at document start, before any page script,
   * for operators that patch browser APIs (XHR, timers, addEventListener, ...).
   */
  phase?: 'init' | 'ready';
  /** Page scope: one mutant per external script/stylesheet of the page (target.resourceUrl). */
  perResource?: 'script' | 'stylesheet';
  /**
   * Page scope: number of mutants per target, distinguished by `params.variant`
   * (0..n-1), e.g. one per rewrite site of a script. Overridable with
   * operatorParams[id].variants.
   */
  variants?: number;
  /** Page scope: generation-time pre-check on the page's recorded elements (default: true). */
  pageApplicable?: (elements: ElementInfo[], params: Record<string, any>) => boolean;
  /**
   * Mutation applied from the test-runner process instead of (or in addition
   * to) the page: viewport size, CPU throttling, resource routing, ...
   */
  nodeApply?: (ctx: DomNodeContext) => Promise<void>;
}

export interface DomNodeContext {
  context: BrowserContext;
  /** Page key the mutant is scoped to ('*' = all pages). */
  pageKey: string;
  resourceUrl?: string;
  params: Record<string, any>;
  applied: (detail: string) => void;
  rand: () => number;
  /** Page key of a URL with the run's pageKeyQuery/pageKeyNormalize settings. */
  pageKeyOf: (url: string) => string;
}

export interface NetworkHandlerContext {
  route: Route;
  request: Request;
  params: Record<string, any>;
  /** Report that the mutation was applied (otherwise the mutant is SKIPPED). */
  applied: (detail: string) => void;
  rand: () => number;
  /** Mutable state shared by all requests of one mutant run (e.g. held responses). */
  state: Record<string, any>;
  /** Matches requests of the mutant's endpoint (for operators that coordinate several requests). */
  matches: (request: Request) => boolean;
}

/** What the trace knows about an endpoint (generation-time applicability). */
export interface EndpointInfo {
  method: string;
  url: string;
  resourceType: string;
  status: number;
  contentType: string;
  json?: JsonShape;
}

export interface NetworkOperatorDef extends OperatorInfo {
  layer: 'network';
  /** Generation-time pre-check on the recorded endpoint (default: true). */
  applicable?: (ep: EndpointInfo, params: Record<string, any>) => boolean;
  /**
   * Called for every request matching the mutant's endpoint. Must settle the
   * route (`fulfill`, `abort`, `continue` or `fallback`).
   * Built-in operators leave this undefined (implemented in network/runtime).
   */
  handle?: (ctx: NetworkHandlerContext) => Promise<void>;
  /** Also call `handle` for requests outside the endpoint (it must `fallback()` them itself). */
  observeAll?: boolean;
}

export interface TestSite {
  edits: { start: number; end: number; text: string }[];
  line: number;
  snippet: string;
  description: string;
}

export interface TestOperatorDef extends OperatorInfo {
  layer: 'test';
  /** Locate the mutation sites in a parsed test file. Built-ins leave this undefined. */
  findSites?: (sourceFile: TS.SourceFile, params: Record<string, any>, ts: typeof TS) => TestSite[];
}

export type OperatorDef = DomOperatorDef | NetworkOperatorDef | TestOperatorDef;

export interface MlmtPlugin {
  name: string;
  operators?: OperatorDef[];
}

type Input<T extends OperatorDef> = Omit<T, 'family' | 'layer' | 'defaults' | 'category' | 'intent' | 'scope'> &
  Partial<Pick<T, 'defaults' | 'category' | 'intent'>>;

function base(id: string, layer: Layer, d: { defaults?: Record<string, unknown>; category?: string; intent?: string }) {
  if (!/^[A-Za-z][\w-]*(\.[\w-]+)+$/.test(id)) throw new Error(`invalid operator id "${id}" (expected FAMILY.name[.variant])`);
  return { id, family: id.split('.')[0], layer, defaults: d.defaults || {}, category: d.category || 'Custom', intent: d.intent || '', scope: (d as any).scope };
}

export function defineDomOperator(o: Input<DomOperatorDef> & { scope?: DomScope }): DomOperatorDef {
  if (!o.apply && !o.nodeApply) throw new Error(`DOM operator ${o.id}: "apply" or "nodeApply" is required`);
  return { ...o, ...base(o.id, 'dom', o), scope: o.scope || 'element' } as DomOperatorDef;
}
export function defineNetworkOperator(o: Input<NetworkOperatorDef>): NetworkOperatorDef {
  if (!o.handle) throw new Error(`network operator ${o.id}: "handle" is required`);
  return { ...o, ...base(o.id, 'network', o) } as NetworkOperatorDef;
}
export function defineTestOperator(o: Input<TestOperatorDef>): TestOperatorDef {
  if (!o.findSites) throw new Error(`test operator ${o.id}: "findSites" is required`);
  return { ...o, ...base(o.id, 'test', o) } as TestOperatorDef;
}
export function definePlugin(p: MlmtPlugin): MlmtPlugin {
  return p;
}

function normalise(def: OperatorDef): OperatorDef {
  if (!def || typeof def !== 'object' || !def.id) throw new Error('operator definition needs an "id"');
  base(def.id, def.layer, def); // validates the id first
  switch (def.layer) {
    case 'dom':
      return defineDomOperator(def as any);
    case 'network':
      return defineNetworkOperator(def as any);
    case 'test':
      return defineTestOperator(def as any);
    default:
      throw new Error(`operator ${(def as OperatorDef).id}: layer must be "dom", "network" or "test"`);
  }
}

const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

export class OperatorRegistry {
  private ops = new Map<string, OperatorDef>();
  private loaded = new Set<string>();

  constructor(builtins: OperatorInfo[] = ALL_OPERATORS, library: OperatorDef[] = LITERATURE_OPERATORS) {
    for (const o of builtins) this.ops.set(o.id, { ...o, scope: o.scope } as OperatorDef);
    for (const o of library) this.register({ ...o, set: 'literature' } as OperatorDef);
  }

  /** Register a custom operator (plain objects are normalised and validated). */
  register(def: OperatorDef, opts: { override?: boolean } = {}): this {
    const d = normalise(def);
    if (this.ops.has(d.id) && !opts.override) throw new Error(`operator ${d.id} is already registered`);
    this.ops.set(d.id, d);
    return this;
  }

  registerPlugin(plugin: MlmtPlugin, opts: { override?: boolean } = {}): this {
    if (this.loaded.has('plugin:' + plugin.name)) return this;
    for (const op of plugin.operators || []) this.register(op, opts);
    this.loaded.add('plugin:' + plugin.name);
    return this;
  }

  /** Load a plugin module (.js/.cjs/.mjs) exporting a plugin as default or `module.exports`. */
  async loadPluginFile(file: string): Promise<MlmtPlugin> {
    const abs = path.resolve(file);
    const mod = /\.mjs$/.test(abs) ? await dynamicImport(pathToFileURL(abs).href) : require(abs);
    const plugin: MlmtPlugin = mod?.default ?? mod;
    if (!plugin || typeof plugin !== 'object' || !plugin.name) throw new Error(`${file} does not export an MultilayerMT plugin`);
    if (!this.loaded.has('file:' + abs)) {
      this.registerPlugin(plugin);
      this.loaded.add('file:' + abs);
    }
    return plugin;
  }

  async loadPlugins(files: string[] = []): Promise<void> {
    for (const f of files) await this.loadPluginFile(f);
  }

  get(id: string): OperatorDef {
    const o = this.ops.get(id);
    if (!o) throw new Error(`unknown mutation operator: ${id}`);
    return o;
  }
  has(id: string): boolean {
    return this.ops.has(id);
  }
  list(layer?: Layer): OperatorDef[] {
    const all = [...this.ops.values()];
    return layer ? all.filter((o) => o.layer === layer) : all;
  }
  /** One of the 51 thesis operators (implemented natively in domMutator/runtime/astMutator). */
  isBuiltin(id: string): boolean {
    return ALL_OPERATORS.some((o) => o.id === id);
  }
}

/** Process-wide default registry (used by the engine, the CLI and the runtime fixture). */
export const registry = new OperatorRegistry();
