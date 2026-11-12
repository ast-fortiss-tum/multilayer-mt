import * as fs from 'fs';
import * as path from 'path';
import type { ResolvedConfig } from '../config';
import { registry as defaultRegistry, OperatorRegistry, DomOperatorDef } from '../operators/registry';
import { findSites } from '../operators/test/astMutator';
import type { ElementInfo, JsonShape, MutantDescriptor, NetworkRecord, OperatorInfo, PwePage, SuiteTrace } from '../types';
import { walk } from '../util/fs';

/**
 * Mutant generation (thesis Sec. 4.5, step 3): for each PWE enumerate the
 * applicable DOM operators; for each observed endpoint the network operators;
 * for each test file the test-script operators.
 */

export function enabledOperators(cfg: ResolvedConfig, ops: OperatorInfo[]): OperatorInfo[] {
  const inc = cfg.operators.include;
  const exc = new Set(cfg.operators.exclude || []);
  const match = (id: string, pats: string[]) => pats.some((p) => p === id || id.startsWith(p.endsWith('.') ? p : p + '.'));
  return ops.filter((o) => cfg.layers.includes(o.layer) && (!inc || inc.length === 0 || match(o.id, inc)) && !match(o.id, [...exc]));
}

function paramsFor(cfg: ResolvedConfig, op: OperatorInfo, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...op.defaults, ...extra, ...(cfg.operatorParams[op.id] || {}) };
}

/* ---------------------------------------------------------------- DOM */

const SEMANTIC_INPUT_TYPES = ['email', 'number', 'tel', 'url', 'date', 'datetime-local', 'month', 'week', 'time', 'search', 'password', 'range', 'color'];
const TEXT_INPUT_TYPES = ['text', 'email', 'search', 'tel', 'url', 'password', ''];
const VOID_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'textarea', 'select'];
const ROUTE_ATTRS = ['routerlink', 'ng-reflect-router-link', 'to', 'data-route', 'data-href'];

function isFormControl(el: ElementInfo): boolean {
  return ['input', 'select', 'textarea'].includes(el.tag) && !['hidden', 'submit', 'button', 'reset', 'image'].includes((el.attrs.type || '').toLowerCase());
}
function isClickable(el: ElementInfo): boolean {
  const role = el.attrs.role || el.facts.implicitRole || '';
  return (
    ['button', 'a', 'summary', 'label'].includes(el.tag) ||
    (el.tag === 'input' && ['submit', 'button', 'reset', 'checkbox', 'radio', 'image'].includes((el.attrs.type || '').toLowerCase())) ||
    'onclick' in el.attrs ||
    ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'option', 'switch'].includes(role)
  );
}
function isSubmitter(el: ElementInfo): boolean {
  return el.tag === 'form' || (el.facts.inForm && (el.tag === 'button' ? (el.attrs.type || 'submit') === 'submit' : el.tag === 'input' && ['submit', 'image'].includes(el.attrs.type || '')));
}

/** Static applicability (generation-time pre-check) of an element-scoped DOM operator. */
export function domApplicable(opId: string, el: ElementInfo, mapping?: Record<string, string>): boolean {
  const a = el.attrs;
  const type = (a.type || 'text').toLowerCase();
  switch (opId) {
    case 'AAM.required.add': return isFormControl(el) && !('required' in a);
    case 'AAM.placeholder.remove': return 'placeholder' in a;
    case 'AAM.inputType.swap': return el.tag === 'input' && SEMANTIC_INPUT_TYPES.includes(type);
    case 'AAM.ariaLabel.remove': return 'aria-label' in a || 'aria-labelledby' in a;
    case 'AMM.href.null': return el.tag === 'a' && !!a.href && a.href !== '#';
    case 'CDM.text.delete': return !isFormControl(el) && el.facts.textNodeWords >= 1;
    case 'CDM.text.shuffle': return !isFormControl(el) && el.facts.textNodeWords >= 2;
    case 'CDM.text.leet': return !isFormControl(el) && /[aeiostlAEIOST]/.test(el.text);
    case 'CDM.input.prependWhitespace': return el.tag === 'textarea' || (el.tag === 'input' && TEXT_INPUT_TYPES.includes(a.type === undefined ? '' : type));
    case 'EHDM.click.remove':
    case 'EVD.click.stopPropagation':
    case 'EVD.click.delay': return isClickable(el);
    case 'EVD.submit.delay': return isSubmitter(el);
    case 'SVM.visibility.hide':
    case 'SVM.display.none':
    case 'SVM.opacity.dim': return el.visibility.displayed && el.visibility.nonZeroSize;
    case 'SVM.force.scroll': return el.visibility.displayed && el.facts.childElementCount > 0;
    case 'TIM.insert.ghostDiv': return !VOID_TAGS.includes(el.tag);
    case 'TIM.wrap.div': return true;
    case 'TIM.form.reorderFields': return (el.tag === 'form' || el.facts.inForm) && el.facts.formControlCount >= 2;
    case 'FVM.required.toggle': return isFormControl(el);
    case 'PVM.pattern.break': return 'pattern' in a;
    case 'FVM.minmax.remove': return ['min', 'max', 'minlength', 'maxlength'].some((k) => k in a);
    case 'ATD.alt.delete': return el.facts.hasImgWithAlt;
    case 'ARM.role.modify': {
      const role = a.role || el.facts.implicitRole;
      return !!role && !!mapping && role in mapping;
    }
    case 'LUM.label.unlink': return el.tag === 'label' ? !!a.for : el.facts.associatedLabel;
    case 'ARM.describedby.remove': return 'aria-describedby' in a;
    case 'BSM.img.break': return el.facts.hasImgDescendant;
    case 'RLB.router.break': return ROUTE_ATTRS.some((k) => k in a);
    default: return false;
  }
}

/** Operators whose effective target is the enclosing form (deduplicated per form). */
const FORM_SCOPED = new Set(['TIM.form.reorderFields', 'EVD.submit.delay']);

const SAFE_NODE_TAGS = ['footer', 'aside'];
const SAFE_NODE_ROLES = ['banner', 'contentinfo', 'complementary'];

function generateDom(cfg: ResolvedConfig, pwe: PwePage[], trace: SuiteTrace, reg: OperatorRegistry): Omit<MutantDescriptor, 'id'>[] {
  const ops = enabledOperators(cfg, reg.list('dom')) as DomOperatorDef[];
  const out: Omit<MutantDescriptor, 'id'>[] = [];
  const seen = new Set<string>();
  const push = (m: Omit<MutantDescriptor, 'id'>, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };

  // page-level facts from the trace
  const pageSnap = new Map<string, ElementInfo[]>();
  const pageResources = new Map<string, { kind: string; url: string }[]>();
  for (const t of trace.tests) {
    for (const [pk, els] of Object.entries(t.snapshots)) {
      const arr = pageSnap.get(pk) || [];
      arr.push(...Object.values(els));
      pageSnap.set(pk, arr);
    }
    for (const r of t.resources) {
      const arr = pageResources.get(r.pageKey) || [];
      if (!arr.some((x) => x.url === r.url)) arr.push({ kind: r.kind, url: r.url });
      pageResources.set(r.pageKey, arr);
    }
  }

  for (const page of pwe) {
    const files = cfg.testSelection === 'all' ? [] : page.testFiles;
    for (const pweEl of page.selected) {
      const el = pweEl.element;
      for (const op of ops.filter((o) => o.scope === 'element')) {
        const params = paramsFor(cfg, op);
        const ok = reg.isBuiltin(op.id)
          ? domApplicable(op.id, el, params.mapping as Record<string, string> | undefined)
          : op.applicable ? op.applicable(el, params) : true;
        if (!ok) continue;
        let selector = el.selector;
        if (FORM_SCOPED.has(op.id) && el.tag !== 'form' && el.facts.formSelector) selector = el.facts.formSelector;
        push(
          {
            operator: op.id,
            layer: 'dom',
            target: { kind: 'dom', pageKey: page.pageKey, selector, description: `<${el.tag}> ${selector} (PWE #${pweEl.rank}, score ${pweEl.score})` },
            params,
            testFiles: files,
          },
          `${op.id}|${page.pageKey}|${selector}`,
        );
      }
    }
    // page-scoped operators
    const els = pageSnap.get(page.pageKey) || [];
    for (const op of ops.filter((o) => o.scope === 'page')) {
      const params = paramsFor(cfg, op);
      if (!reg.isBuiltin(op.id)) {
        push(
          { operator: op.id, layer: 'dom', target: { kind: 'dom', pageKey: page.pageKey, description: `page ${page.pageKey}` }, params, testFiles: files },
          `${op.id}|${page.pageKey}`,
        );
      } else if (op.id === 'TIM.node.removeSafe') {
        const has = els.some((e) => SAFE_NODE_TAGS.includes(e.tag) || SAFE_NODE_ROLES.includes(e.attrs.role || '') || /\bbanner\b/.test(e.attrs.class || ''));
        push(
          {
            operator: op.id,
            layer: 'dom',
            target: { kind: 'dom', pageKey: page.pageKey, description: `safe nodes on ${page.pageKey}` },
            params,
            testFiles: files,
            precheckFailed: has ? undefined : 'no safe structural node (footer/aside/banner) on page',
          },
          `${op.id}|${page.pageKey}`,
        );
      } else {
        const kind = op.id === 'SFM.script.fail' ? 'script' : 'stylesheet';
        const res = (pageResources.get(page.pageKey) || []).filter((r) => r.kind === kind);
        if (!res.length) {
          push(
            {
              operator: op.id,
              layer: 'dom',
              target: { kind: 'dom', pageKey: page.pageKey, description: `${kind}s on ${page.pageKey}` },
              params,
              testFiles: files,
              precheckFailed: `no external ${kind} on page`,
            },
            `${op.id}|${page.pageKey}`,
          );
        }
        for (const r of res) {
          push(
            {
              operator: op.id,
              layer: 'dom',
              target: { kind: 'dom', pageKey: page.pageKey, resourceUrl: r.url, description: `${kind} ${r.url}` },
              params,
              testFiles: files,
            },
            `${op.id}|${page.pageKey}|${r.url}`,
          );
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ network */

function mangle(name: string): string {
  const m = name.slice(1).search(/[aeiou]/i);
  return m >= 0 ? name.slice(0, m + 1) + name.slice(m + 2) : name + '_x';
}

/** Infer operator parameters from the observed JSON payload shape. */
export function inferNetworkParams(opId: string, defaults: Record<string, unknown>, shape?: JsonShape): Record<string, unknown> {
  if (!shape || !Object.keys(shape.fields).length) return {};
  const fields = Object.keys(shape.fields);
  const has = (f: unknown) => typeof f === 'string' && f in shape.fields;
  const typed = (t: string) => fields.filter((f) => shape.fields[f].split('|').includes(t));
  switch (opId) {
    case 'NPF.field.drop':
      return has(defaults.fieldName) ? {} : { fieldName: fields[0] };
    case 'NPR.field.rename': {
      const oldName = has(defaults.oldName) ? (defaults.oldName as string) : fields[0];
      return oldName === defaults.oldName ? {} : { oldName, newName: mangle(oldName) };
    }
    case 'NPT.type.change': {
      if (has(defaults.fieldName)) return {};
      const numeric = typed('number');
      const numericStrings = typed('string').filter((f) => typeof shape.samples[f] === 'string' && /^-?\d+(\.\d+)?$/.test(String(shape.samples[f])));
      const f = numeric[0] || numericStrings[0] || typed('boolean')[0];
      return f ? { fieldName: f } : {};
    }
    case 'NPE.enum.invalid': {
      if (has(defaults.fieldName)) return {};
      const strings = typed('string');
      const enumLike = strings.find((f) => /^(status|state|type|kind|role|level|priority|category|mode)$/i.test(f)) ||
        strings.find((f) => /^[A-Za-z_]{2,20}$/.test(String(shape.samples[f] ?? '')));
      const f = enumLike || strings[0];
      return f ? { fieldName: f } : {};
    }
    default:
      return {};
  }
}

function generateNetwork(cfg: ResolvedConfig, trace: SuiteTrace, reg: OperatorRegistry): Omit<MutantDescriptor, 'id'>[] {
  const ops = enabledOperators(cfg, reg.list('network'));
  const include = cfg.network.include ? new RegExp(cfg.network.include) : null;
  const exclude = cfg.network.exclude ? new RegExp(cfg.network.exclude) : null;
  const pageOrigins = new Set<string>();
  for (const t of trace.tests) for (const pk of Object.keys(t.snapshots)) pageOrigins.add(new URL(pk).origin);

  const endpoints = new Map<string, { rec: NetworkRecord; files: Set<string>; shape?: JsonShape }>();
  for (const t of trace.tests) {
    for (const r of t.network) {
      if (!cfg.network.resourceTypes.includes(r.resourceType)) continue;
      const u = new URL(r.url);
      if (!cfg.network.thirdParty && pageOrigins.size && !pageOrigins.has(u.origin)) continue;
      if (include && !include.test(r.endpoint)) continue;
      if (exclude && exclude.test(r.endpoint)) continue;
      const e = endpoints.get(r.endpoint);
      if (!e) endpoints.set(r.endpoint, { rec: r, files: new Set([t.testFile]), shape: r.json });
      else {
        e.files.add(t.testFile);
        if (!e.shape && r.json) e.shape = r.json;
      }
    }
  }
  const out: Omit<MutantDescriptor, 'id'>[] = [];
  for (const [endpoint, { rec, files, shape }] of [...endpoints.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const u = new URL(rec.url);
    for (const op of ops) {
      const params = paramsFor(cfg, op, inferNetworkParams(op.id, op.defaults, shape));
      out.push({
        operator: op.id,
        layer: 'network',
        target: {
          kind: 'network',
          endpoint,
          method: rec.method,
          urlBase: u.origin + u.pathname,
          description: `${endpoint} [${rec.resourceType}${shape ? ', json' : ''}]`,
        },
        params,
        testFiles: cfg.testSelection === 'all' ? [] : [...files].sort(),
      });
    }
  }
  return out;
}

/* --------------------------------------------------------------- test */

export function listTestFiles(cfg: ResolvedConfig, extra: string[] = []): string[] {
  const re = new RegExp(cfg.testFilePattern);
  const onDisk = walk(cfg.abs.testDir).map((f) => f.split(path.sep).join('/'));
  return [...new Set([...onDisk, ...extra])].filter((f) => re.test(f)).sort();
}

/** Sources of all test files: on-disk files overlaid with in-memory ones. */
export function readTestSources(cfg: ResolvedConfig, inline: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listTestFiles(cfg, Object.keys(inline))) out[f] = inline[f] ?? fs.readFileSync(path.join(cfg.abs.testDir, f), 'utf8');
  return out;
}

function generateTest(cfg: ResolvedConfig, sources: Record<string, string>, reg: OperatorRegistry): Omit<MutantDescriptor, 'id'>[] {
  const ops = enabledOperators(cfg, reg.list('test'));
  const out: Omit<MutantDescriptor, 'id'>[] = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const op of ops) {
      const params = paramsFor(cfg, op);
      const sites = findSites(op.id, file, source, params);
      if (!sites.length) {
        out.push({
          operator: op.id,
          layer: 'test',
          target: { kind: 'test', file, site: -1, description: `${file}: no ${op.id} pattern` },
          params,
          testFiles: [file],
          precheckFailed: 'no matching AST pattern in test file',
        });
        continue;
      }
      sites.slice(0, Math.max(1, cfg.test.maxSitesPerOperator)).forEach((s, i) => {
        out.push({
          operator: op.id,
          layer: 'test',
          target: { kind: 'test', file, site: i, line: s.line, snippet: s.snippet, description: `${file}:${s.line} ${s.description}` },
          params,
          testFiles: [file],
        });
      });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- all */

export interface GenerateOptions {
  /** Test sources (relative path -> source); default: read from testDir. */
  testSources?: Record<string, string>;
  registry?: OperatorRegistry;
}

/** Generate the mutant descriptors of all enabled layers (deterministic ids D/N/T0001...). */
export function generateMutants(cfg: ResolvedConfig, pwe: PwePage[], trace: SuiteTrace, opts: GenerateOptions = {}): MutantDescriptor[] {
  const reg = opts.registry ?? defaultRegistry;
  const all = [
    ...(cfg.layers.includes('dom') ? generateDom(cfg, pwe, trace, reg) : []),
    ...(cfg.layers.includes('network') ? generateNetwork(cfg, trace, reg) : []),
    ...(cfg.layers.includes('test') ? generateTest(cfg, opts.testSources ?? readTestSources(cfg), reg) : []),
  ];
  const prefix = { dom: 'D', network: 'N', test: 'T' } as const;
  const counters = { dom: 0, network: 0, test: 0 };
  return all.map((m) => ({ id: `${prefix[m.layer]}${String(++counters[m.layer]).padStart(4, '0')}`, ...m }));
}
