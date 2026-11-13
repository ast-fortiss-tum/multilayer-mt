import * as ts from 'typescript';
import { registry, TestOperatorDef } from '../registry';
import {
  TextEdit, Site, WAIT_METHODS, ACTION_METHODS, SELECTOR_METHODS, GET_BY, NO_ARG_MATCHERS, lineOf, snippetOf, visit, methodName, unwrap, isExpectCall, MatcherCall, asMatcherCall, rootIdentifier, indentAt, isStringLike, replaceLiteral, site,
} from './astUtil';

export type { TextEdit, Site } from './astUtil';

/**
 * Test-script layer operators (thesis Sec. 4.2.1, "Test-Script Layer Operators").
 *
 * Each operator locates its AST pattern in a Playwright test file and yields one
 * *site* per match. A site is a list of text edits; applying it produces the
 * mutated test variant. Editing the original text (instead of re-printing the
 * AST) keeps formatting, comments and line numbers stable.
 */

type Params = Record<string, any>;
type SiteFinder = (sf: ts.SourceFile, params: Params) => Site[];

/* ----------------------------------------------------- CSS selector rules */

export function isCssSelector(sel: string): boolean {
  const s = sel.trim();
  if (!s) return false;
  if (/^(text|xpath|role|id|data-testid|internal|css)=/.test(s)) return /^css=/.test(s);
  if (s.startsWith('//') || s.startsWith('..') || s.startsWith('(') || s.startsWith('"') || s.startsWith("'")) return false;
  if (s.includes('>>')) return false;
  return true;
}

/** Split a selector into compound selectors and combinators (respecting (), [] and quotes). */
function splitCompounds(sel: string): { parts: string[]; combinators: string[] } {
  const parts: string[] = [];
  const combinators: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (quote) {
      cur += ch;
      if (ch === quote && sel[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      let j = i;
      let comb = '';
      while (j < sel.length && /[\s>+~]/.test(sel[j])) { comb += sel[j]; j++; }
      if (cur) { parts.push(cur); combinators.push(comb.trim() || ' '); cur = ''; }
      i = j - 1;
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return { parts, combinators: combinators.slice(0, Math.max(0, parts.length - 1)) };
}

function join(parts: string[], combinators: string[]): string {
  let out = parts[0] || '';
  for (let i = 1; i < parts.length; i++) {
    const c = combinators[i - 1] || ' ';
    out += c === ' ' ? ' ' + parts[i] : ` ${c} ${parts[i]}`;
  }
  return out;
}

/**
 * SOG rewrite rule: make the selector more generic.
 *   tag#id -> tag; #id.cls -> .cls; .a.b -> .a; tag[attr=v] -> tag;
 *   ancestor > child -> child; #id -> [id]; .cls -> *; tag -> *
 */
export function generalizeSelector(sel: string): string | null {
  if (!isCssSelector(sel)) return null;
  const prefix = sel.startsWith('css=') ? 'css=' : '';
  const body = sel.slice(prefix.length).trim();
  if (body.includes(',')) return null;
  const { parts, combinators } = splitCompounds(body);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  const tag = (last.match(/^[a-zA-Z][\w-]*|^\*/) || [''])[0];
  const ids = last.match(/#[\w-]+(?:\\.[\w-]*)*/g) || [];
  const classes = last.match(/\.[\w-]+/g) || [];
  const attrs = last.match(/\[[^\]]*\]/g) || [];
  const pseudos = last.match(/:{1,2}[\w-]+(\([^)]*\))?/g) || [];
  const others = (tag ? 1 : 0) + classes.length + attrs.length + pseudos.length;

  let next: string | null = null;
  if (ids.length && others > 0) next = ids.reduce((s, id) => s.replace(id, ''), last);
  else if (attrs.length && (tag || classes.length || pseudos.length)) next = attrs.reduce((s, a) => s.replace(a, ''), last);
  else if (classes.length > 1) next = (tag || '') + classes[0] + attrs.join('') + pseudos.join('');
  else if (pseudos.length && (tag || classes.length || attrs.length)) next = pseudos.reduce((s, p) => s.replace(p, ''), last);
  else if (parts.length > 1) return prefix + last;
  else if (ids.length) next = '[id]';
  else if (attrs.length === 1 && /=/.test(attrs[0])) next = attrs[0].replace(/[~|^$*]?=.*\]$/, ']');
  else if (classes.length === 1 || tag) next = '*';
  if (!next) return null;
  if (!next.trim()) next = '*';
  const result = prefix + join([...parts.slice(0, -1), next], combinators);
  return result === sel ? null : result;
}

/** SOS rewrite rule: add a positional constraint. */
export function specializeSelector(sel: string, index = 3): string | null {
  if (!isCssSelector(sel)) return null;
  if (/:nth-(child|of-type)\(/.test(sel) || sel.includes(',')) return null;
  if (/::[\w-]+$/.test(sel)) return null;
  return `${sel}:nth-child(${index})`;
}

/** Methods whose first argument is a value (text, key, option, event name, attribute name) on a locator. */
const VALUE_FIRST_METHODS = new Set(['fill', 'type', 'press', 'pressSequentially', 'selectOption', 'setInputFiles', 'getAttribute', 'dispatchEvent', 'setChecked']);

/**
 * Is the first argument of this call a key or a value, not a selector?
 * `locator.fill(value[, opts])`, `locator.press(key[, opts])`, `locator.dispatchEvent(type)`,
 * ... and every `keyboard.*` call (`page.keyboard.press('Enter')`). Only the
 * `page.fill(selector, value[, opts])` form has a selector first.
 */
function isKeyArgument(call: ts.CallExpression, name: string): boolean {
  const e = call.expression;
  if (ts.isPropertyAccessExpression(e)) {
    const r = e.expression;
    if ((ts.isIdentifier(r) && r.text === 'keyboard') || (ts.isPropertyAccessExpression(r) && r.name.text === 'keyboard')) return true;
  }
  if (!VALUE_FIRST_METHODS.has(name)) return false;
  const second = call.arguments[1];
  return !second || ts.isObjectLiteralExpression(second);
}

/* ------------------------------------------------------------- operators */

const finders: Record<string, SiteFinder> = {
  'TWR.wait.remove': (sf) => {
    const sites: Site[] = [];
    visit(sf, (n) => {
      if (!ts.isExpressionStatement(n)) return;
      const e = unwrap(n.expression);
      if (!ts.isCallExpression(e)) return;
      const name = methodName(e);
      if (!name || !WAIT_METHODS.has(name)) return;
      if (name === 'waitFor' && !ts.isPropertyAccessExpression(e.expression)) return;
      sites.push({
        edits: [{ start: n.getStart(sf), end: n.end, text: `/* [mlmt] TWR removed: ${name} */` }],
        line: lineOf(sf, n.getStart(sf)),
        snippet: snippetOf(sf, n),
        description: `remove ${name}()`,
      });
    });
    return sites;
  },

  'TWA.wait.add': (sf, p) => {
    const ms = Number(p.delayMs ?? 1000);
    const sites: Site[] = [];
    visit(sf, (n) => {
      if (!ts.isExpressionStatement(n) || !ts.isAwaitExpression(n.expression)) return;
      const e = unwrap(n.expression);
      if (!ts.isCallExpression(e)) return;
      const name = methodName(e);
      if (!name || !ACTION_METHODS.has(name) || !ts.isPropertyAccessExpression(e.expression)) return;
      const root = rootIdentifier(e);
      const wait = root && /page$/i.test(root)
        ? `await ${root}.waitForTimeout(${ms});`
        : `await new Promise((r) => setTimeout(r, ${ms}));`;
      const start = n.getStart(sf);
      sites.push({
        edits: [{ start, end: start, text: `${wait}\n${indentAt(sf, start)}` }],
        line: lineOf(sf, start),
        snippet: snippetOf(sf, n),
        description: `insert ${ms}ms wait before ${name}()`,
      });
    });
    return sites;
  },

  'AOL.assert.loosen': (sf, p) => matcherSwap(sf, (p.matcherMap || {}) as Record<string, string>, 'loosen'),
  'AOT.assert.tighten': (sf, p) => matcherSwap(sf, (p.matcherMap || {}) as Record<string, string>, 'tighten'),

  'AOV.visual.tolerance': (sf, p) => {
    const sites: Site[] = [];
    const strict: Record<string, unknown> = { maxDiffPixels: p.maxDiffPixels ?? 0, threshold: p.threshold ?? 0 };
    const strictText = Object.entries(strict).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
    visit(sf, (n) => {
      const m = asMatcherCall(n);
      if (!m || !['toHaveScreenshot', 'toMatchSnapshot'].includes(m.name)) return;
      const args = m.call.arguments;
      const last = args[args.length - 1];
      let edit: TextEdit;
      if (last && ts.isObjectLiteralExpression(last)) {
        const kept = last.properties
          .filter((pr) => !(pr.name && ts.isIdentifier(pr.name) && ['maxDiffPixels', 'maxDiffPixelRatio', 'threshold'].includes(pr.name.text)))
          .map((pr) => pr.getText(sf));
        edit = { start: last.getStart(sf), end: last.end, text: `{ ${[...kept, strictText].join(', ')} }` };
      } else {
        const closeParen = m.call.end - 1;
        edit = { start: closeParen, end: closeParen, text: `${args.length ? ', ' : ''}{ ${strictText} }` };
      }
      sites.push({
        edits: [edit],
        line: lineOf(sf, m.call.getStart(sf)),
        snippet: snippetOf(sf, m.call),
        description: `${m.name} tolerance -> ${strictText}`,
      });
    });
    return sites;
  },

  'AOF.assert.flip': (sf) => {
    const sites: Site[] = [];
    visit(sf, (n) => {
      const m = asMatcherCall(n);
      if (!m) return;
      const edit: TextEdit = m.notAccess
        ? { start: m.expectCall.end, end: m.notAccess.end, text: '' }
        : { start: m.expectCall.end, end: m.expectCall.end, text: '.not' };
      sites.push({
        edits: [edit],
        line: lineOf(sf, m.call.getStart(sf)),
        snippet: snippetOf(sf, m.call),
        description: m.notAccess ? `not.${m.name} -> ${m.name}` : `${m.name} -> not.${m.name}`,
      });
    });
    return sites;
  },

  'SOG.selector.generalize': (sf) => {
    const sites: Site[] = [];
    visit(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const name = methodName(n);
      if (!name || !ts.isPropertyAccessExpression(n.expression)) return;
      const first = n.arguments[0];
      if (SELECTOR_METHODS.has(name) && isStringLike(first) && !isKeyArgument(n, name)) {
        const g = generalizeSelector(first.text);
        if (g) sites.push(site(sf, n, [replaceLiteral(sf, first, g)], `selector "${first.text}" -> "${g}"`));
        return;
      }
      if (GET_BY.has(name) && name !== 'getByTestId') {
        const opts = n.arguments[1];
        if (opts && ts.isObjectLiteralExpression(opts)) {
          const hasNameOrExact = opts.properties.some((pr) => pr.name && ts.isIdentifier(pr.name) && ['name', 'exact'].includes(pr.name.text));
          if (hasNameOrExact) {
            sites.push(site(sf, n, [{ start: n.arguments[0].end, end: opts.end, text: '' }], `${name}: drop name/exact options`));
            return;
          }
        }
        if (name !== 'getByRole' && isStringLike(first)) {
          const words = first.text.trim().split(/\s+/);
          if (words.length > 1) sites.push(site(sf, n, [replaceLiteral(sf, first, words[0])], `${name}("${first.text}") -> ${name}("${words[0]}")`));
        }
      }
    });
    return sites;
  },

  'SOS.selector.specialize': (sf, p) => {
    const index = Number(p.index ?? 3);
    const sites: Site[] = [];
    visit(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const name = methodName(n);
      if (!name || !ts.isPropertyAccessExpression(n.expression)) return;
      const first = n.arguments[0];
      if (SELECTOR_METHODS.has(name) && isStringLike(first) && !isKeyArgument(n, name)) {
        const s = specializeSelector(first.text, index);
        if (s) sites.push(site(sf, n, [replaceLiteral(sf, first, s)], `selector "${first.text}" -> "${s}"`));
        return;
      }
      if (GET_BY.has(name)) {
        // positional constraint on a locator chain: getByX(...) -> getByX(...).nth(index-1)
        const parent = n.parent;
        if (parent && ts.isPropertyAccessExpression(parent) && ['nth', 'first', 'last'].includes(parent.name.text)) return;
        sites.push(site(sf, n, [{ start: n.end, end: n.end, text: `.nth(${index - 1})` }], `${name}(...) -> ${name}(...).nth(${index - 1})`));
      }
    });
    return sites;
  },
};

function matcherSwap(sf: ts.SourceFile, map: Record<string, string>, mode: 'loosen' | 'tighten'): Site[] {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const m = asMatcherCall(n);
    if (!m || !map[m.name]) return;
    const to = map[m.name];
    const args = m.call.arguments;
    const nameStart = m.access.name.getStart(sf);
    let edit: TextEdit;
    if (NO_ARG_MATCHERS.has(to)) {
      edit = { start: nameStart, end: m.call.end, text: `${to}()` };
    } else if (!args.length) {
      // e.g. toBeTruthy() -> toBe(true)
      edit = { start: nameStart, end: m.call.end, text: `${to}(true)` };
    } else {
      edit = { start: nameStart, end: m.access.name.end, text: to };
    }
    sites.push({
      edits: [edit],
      line: lineOf(sf, m.call.getStart(sf)),
      snippet: snippetOf(sf, m.call),
      description: `${mode}: ${m.name} -> ${to}`,
    });
  });
  return sites;
}

/* ------------------------------------------------------------ public API */

export const TEST_OPERATOR_IDS = Object.keys(finders);

export function parse(fileName: string, source: string): ts.SourceFile {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.jsx$/.test(fileName) ? ts.ScriptKind.JSX : /\.(c|m)?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

/** Pre-check: list all mutation sites of `operator` in `source`. */
export function findSites(operator: string, fileName: string, source: string, params: Params = {}): Site[] {
  const sf = parse(fileName, source);
  const finder = finders[operator];
  if (finder) return finder(sf, params);
  const def = registry.has(operator) ? (registry.get(operator) as TestOperatorDef) : null;
  if (def?.layer === 'test' && def.findSites) return def.findSites(sf, params, ts);
  throw new Error(`not a test-script operator: ${operator}`);
}

export function applyEdits(source: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Produce the mutated test source for `operator` at `siteIndex`. */
export function mutateSource(operator: string, fileName: string, source: string, siteIndex: number, params: Params = {}): string {
  const sites = findSites(operator, fileName, source, params);
  const s = sites[siteIndex];
  if (!s) throw new Error(`${operator}: site ${siteIndex} not found in ${fileName}`);
  // appended (not prepended) so that line numbers in stack traces stay stable
  const trailer = `\n/* MultilayerMT mutant: ${operator} @ line ${s.line}: ${s.description.replace(/\*\//g, '* /')} */\n`;
  return applyEdits(source, s.edits) + trailer;
}
