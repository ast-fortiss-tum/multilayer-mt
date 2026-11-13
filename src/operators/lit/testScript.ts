/**
 * Literature test-script operators (Batch E): AST source transformations of
 * Playwright TypeScript test files. Each finder returns one site (a list of
 * text edits) per match, in source order; applying a site must leave the file
 * syntactically valid TypeScript.
 *
 * Sources: Almeida19 (Paiva et al.), Danglot19 (DSpot amplifiers), Maciel17
 * (oracle mutation), Hammoudi16 (record/replay breakages), Romano21 (UI flaky
 * tests), Pei23 (TRaf), Liu24 (WEFix), Nishiura13 (AjaxMutator, test
 * analogue), Mirshokraie15 (Mutandis jQuery selector analogue),
 * LinaresVasquez17 (MDroid+).
 */
import * as ts from 'typescript';
import type { OperatorDef } from '../registry';
import {
  ACTION_METHODS, GET_BY, Site, TextEdit, asMatcherCall, indentAt, isStringLike, methodName, rootIdentifier, site, unwrap, visit,
} from '../test/astUtil';
import { testOp } from './util';

type Params = Record<string, any>;
type Lit = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;

/* ================================================================ helpers */

/** Deterministic integer hash (used instead of rand(): finders are pure). */
function hash(n: number, salt = 0): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Source text of a string literal holding `value`, keeping single/double quote style. */
function quote(raw: string, value: string): string {
  const json = JSON.stringify(value);
  if (raw[0] === "'") return "'" + json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";
  return json; // double quotes, or a former no-substitution template literal
}

function setLit(sf: ts.SourceFile, lit: Lit, value: string): TextEdit {
  return { start: lit.getStart(sf), end: lit.end, text: quote(lit.getText(sf), value) };
}

/** Replace a node by its text. */
function replace(sf: ts.SourceFile, node: ts.Node, text: string): TextEdit {
  return { start: node.getStart(sf), end: node.end, text };
}

/** `expr` with `suffix` appended as a string (literal, template or `${expr}suffix`). */
function appendSuffix(sf: ts.SourceFile, e: ts.Expression, suffix: string): TextEdit | null {
  if (isStringLike(e)) return setLit(sf, e, e.text + suffix);
  if (ts.isTemplateExpression(e)) {
    const raw = e.getText(sf);
    return { start: e.getStart(sf), end: e.end, text: raw.slice(0, -1) + suffix.replace(/[`\\$]/g, '\\$&') + '`' };
  }
  if (ts.isRegularExpressionLiteral(e) || ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e) || ts.isNumericLiteral(e)) return null;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return null;
  return replace(sf, e, '`${' + e.getText(sf) + '}' + suffix.replace(/[`\\$]/g, '\\$&') + '`');
}

/** Wrap an expression in parentheses unless it is a primary/member/call expression. */
function wrap(sf: ts.SourceFile, e: ts.Expression): string {
  const t = e.getText(sf);
  return ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isCallExpression(e) || ts.isElementAccessExpression(e) ? t : `(${t})`;
}

function propName(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
  return null;
}

/** Call of the form `<recv>.name(...)` (property access callee). */
function memberCall(n: ts.Node): (ts.CallExpression & { expression: ts.PropertyAccessExpression }) | null {
  return ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) ? (n as any) : null;
}

/** `page.keyboard.press(...)`, `keyboard.type(...)`: arguments are keys/text, never selectors. */
function isKeyboardCall(call: ts.CallExpression): boolean {
  const e = call.expression;
  if (!ts.isPropertyAccessExpression(e)) return false;
  const r = e.expression;
  return (ts.isIdentifier(r) && r.text === 'keyboard') || (ts.isPropertyAccessExpression(r) && r.name.text === 'keyboard');
}

function receiverName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (!ts.isPropertyAccessExpression(e)) return null;
  const r = e.expression;
  if (ts.isIdentifier(r)) return r.text;
  if (ts.isPropertyAccessExpression(r)) return r.name.text;
  return null;
}

/**
 * The value argument of fill/type/press/pressSequentially/selectOption:
 * `locator.fill(value[, opts])`, `page.fill(selector, value[, opts])`, `keyboard.type(text)`.
 */
function valueArg(call: ts.CallExpression): ts.Expression | undefined {
  const a = call.arguments;
  if (isKeyboardCall(call)) return a[0];
  if (a.length >= 2 && !ts.isObjectLiteralExpression(a[1])) return a[1];
  return a[0] && !ts.isObjectLiteralExpression(a[0]) ? a[0] : undefined;
}

const STEP_METHODS = new Set([...ACTION_METHODS, 'goto']);

/** `await <recv>.<ACTION|goto>(...)` expression statement. */
function actionStatement(n: ts.Node): { stmt: ts.ExpressionStatement; call: ts.CallExpression; name: string } | null {
  if (!ts.isExpressionStatement(n) || !ts.isAwaitExpression(n.expression)) return null;
  const call = memberCall(unwrap(n.expression));
  if (!call) return null;
  const name = call.expression.name.text;
  if (!STEP_METHODS.has(name)) return null;
  return { stmt: n, call, name };
}

/** Statement list containing `stmt` (block, source file, case clause, module block). */
function siblings(stmt: ts.Statement): readonly ts.Statement[] | null {
  const p = stmt.parent;
  if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p) || ts.isDefaultClause(p) || ts.isModuleBlock(p)) return p.statements;
  return null;
}

const isPageRoot = (r: string | null): r is string => !!r && /page$/i.test(r);

/** Remove `obj` from the call's argument list (with its comma). */
function removeArg(sf: ts.SourceFile, call: ts.CallExpression, arg: ts.Expression): TextEdit {
  const args = call.arguments;
  const i = args.indexOf(arg);
  if (i > 0) return { start: args[i - 1].end, end: arg.end, text: '' };
  if (args.length > 1) return { start: arg.getStart(sf), end: args[1].getStart(sf), text: '' };
  return { start: arg.getStart(sf), end: arg.end, text: '' };
}

/**
 * Keep only the properties of `obj` accepted by `keep`; null if nothing changes.
 * An emptied call-argument object is removed from the call; elsewhere it becomes `{}`.
 */
function filterObject(sf: ts.SourceFile, obj: ts.ObjectLiteralExpression, keep: (name: string | null) => boolean): TextEdit | null {
  const kept = obj.properties.filter((p) => keep(propName(p)));
  if (kept.length === obj.properties.length) return null;
  if (!kept.length) {
    const call = obj.parent;
    if (call && ts.isCallExpression(call) && call.arguments.includes(obj)) return removeArg(sf, call, obj);
    return replace(sf, obj, '{}');
  }
  return replace(sf, obj, `{ ${kept.map((p) => p.getText(sf)).join(', ')} }`);
}

/** Matcher call `expect(x)[.not].name(...)` (null otherwise). */
function matcher(n: ts.Node, names?: Set<string> | string[]) {
  const m = asMatcherCall(n);
  if (!m) return null;
  if (names && !(Array.isArray(names) ? names.includes(m.name) : names.has(m.name))) return null;
  return m;
}

/** Replace the matcher name and arguments: `.name(args)` -> `.<text>`. */
function matcherTail(sf: ts.SourceFile, m: NonNullable<ReturnType<typeof asMatcherCall>>, text: string): TextEdit {
  return { start: m.access.name.getStart(sf), end: m.call.end, text };
}

function isNumberLiteral(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  if (ts.isNumericLiteral(e)) return true;
  return ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

function comment(s: string): string {
  return `/* [mlmt] ${s.replace(/\*\//g, '* /')} */`;
}

/* ---------------------------------------------------------- selectors */

const LOCATOR_SELECTOR_METHODS = new Set(['locator', '$', '$$', '$eval', '$$eval', 'waitForSelector']);
/** page.X(selector[, opts]); the Locator variants take no string argument. */
const NO_VALUE_SELECTOR_METHODS = new Set([
  'click', 'dblclick', 'check', 'uncheck', 'hover', 'tap', 'focus', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled',
  'isChecked', 'isEditable', 'textContent', 'innerText', 'innerHTML', 'inputValue',
]);
/** page.X(selector, value[, opts]) vs locator.X(value[, opts]). */
const VALUE_SELECTOR_METHODS = new Set(['fill', 'type', 'press', 'pressSequentially', 'selectOption', 'setInputFiles', 'getAttribute', 'dispatchEvent', 'setChecked']);

/** The selector string literal of a call, if any. */
function selectorLiteral(call: ts.CallExpression): Lit | null {
  if (!ts.isPropertyAccessExpression(call.expression) || isKeyboardCall(call)) return null;
  if (receiverName(call) === 'mouse') return null;
  const name = call.expression.name.text;
  const a0 = call.arguments[0];
  if (!isStringLike(a0)) return null;
  if (LOCATOR_SELECTOR_METHODS.has(name) || NO_VALUE_SELECTOR_METHODS.has(name)) return a0;
  if (VALUE_SELECTOR_METHODS.has(name) && call.arguments.length >= 2 && !ts.isObjectLiteralExpression(call.arguments[1])) return a0;
  return null;
}

/** CSS part of a selector (`css=` prefix kept), null for other engines / XPath / chains. */
function cssParts(sel: string): { prefix: string; body: string } | null {
  if (sel.startsWith('css=')) return { prefix: 'css=', body: sel.slice(4) };
  const s = sel.trim();
  if (!s || /^[\w-]+=/.test(s) || /^internal:/.test(s)) return null;
  if (s.startsWith('//') || s.startsWith('..') || s.startsWith('(') || s.startsWith('"') || s.startsWith("'")) return null;
  if (s.includes('>>')) return null;
  return { prefix: '', body: sel };
}

/** First top-level `#id` / `.class` token of a CSS selector. */
function firstIdOrClass(body: string, only?: '#' | '.'): { index: number; sym: '#' | '.'; ident: string } | null {
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (q) {
      if (ch === '\\') i++;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (depth === 0 && (ch === '#' || ch === '.') && (!only || only === ch)) {
      const m = body.slice(i + 1).match(/^-?(?:[A-Za-z_ -￿]|\\.)(?:[\w -￿-]|\\.)*/);
      if (m) return { index: i, sym: ch, ident: m[0] };
    }
  }
  return null;
}

/* ============================================================== finders */

type Finder = (sf: ts.SourceFile, p: Params) => Site[];

/* ------------------------------------------------------------- TST steps */

const stepRemove: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const a = actionStatement(n);
    if (!a) return;
    sites.push(site(sf, a.stmt, [replace(sf, a.stmt, comment(`TST removed: ${a.name}()`))], `remove ${a.name}() step`));
  });
  return sites;
};

const stepSwap: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const a = actionStatement(n);
    if (!a) return;
    const list = siblings(a.stmt);
    if (!list) return;
    const next = list[list.indexOf(a.stmt) + 1];
    const b = next && actionStatement(next);
    if (!b) return;
    const t0 = a.stmt.getText(sf);
    const t1 = b.stmt.getText(sf);
    if (t0 === t1) return;
    const between = sf.text.slice(a.stmt.end, b.stmt.getStart(sf));
    sites.push(site(sf, a.stmt, [{ start: a.stmt.getStart(sf), end: b.stmt.end, text: t1 + between + t0 }], `swap ${a.name}() with next ${b.name}()`));
  });
  return sites;
};

const stepDuplicate: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const a = actionStatement(n);
    if (!a || !siblings(a.stmt)) return;
    const start = a.stmt.getStart(sf);
    sites.push(site(sf, a.stmt, [{ start: a.stmt.end, end: a.stmt.end, text: `\n${indentAt(sf, start)}${a.stmt.getText(sf)}` }], `duplicate ${a.name}() step`));
  });
  return sites;
};

const stepAddBack: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const a = actionStatement(n);
    if (!a || a.name !== 'click' || !siblings(a.stmt)) return;
    const root = rootIdentifier(a.call);
    if (!isPageRoot(root)) return;
    const ind = indentAt(sf, a.stmt.getStart(sf));
    sites.push(site(sf, a.stmt, [{ start: a.stmt.end, end: a.stmt.end, text: `\n${ind}await ${root}.goBack();\n${ind}${a.stmt.getText(sf)}` }], `go back after click and click again`));
  });
  return sites;
};

const stepRefill: Finder = (sf, p) => {
  const suffix = String(p.suffix ?? 'Mut');
  const sites: Site[] = [];
  visit(sf, (n) => {
    const a = actionStatement(n);
    if (!a || a.name !== 'fill') return;
    const list = siblings(a.stmt);
    if (!list) return;
    const next = list[list.indexOf(a.stmt) + 1];
    const b = next && actionStatement(next);
    if (!b || b.name !== 'fill') return;
    const v = valueArg(a.call);
    if (!v) return;
    const ve = appendSuffix(sf, v, suffix);
    if (!ve) return;
    const s0 = a.stmt.getStart(sf);
    const copy = sf.text.slice(s0, ve.start) + ve.text + sf.text.slice(ve.end, a.stmt.end);
    sites.push(site(sf, b.stmt, [{ start: b.stmt.end, end: b.stmt.end, text: `\n${indentAt(sf, b.stmt.getStart(sf))}${copy}` }], `re-fill the previous field with a changed value`));
  });
  return sites;
};

/* ---------------------------------------------------------- TDT test data */

const WORDS = ['mutant', 'zebra', 'orbit', 'quux', 'lorem', 'delta', 'plum', 'vortex'];

function otherValue(v: string, k: number): string {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v === 'mutant@example.org' ? 'other@example.org' : 'mutant@example.org';
  if (/^-?\d+(\.\d+)?$/.test(v.trim())) return fmt(Number(v) + 1);
  let w = WORDS[k % WORDS.length];
  if (w === v) w = WORDS[(k + 1) % WORDS.length];
  return w;
}

const inputChange: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const call = memberCall(n);
    if (!call || !['fill', 'type', 'pressSequentially', 'insertText'].includes(call.expression.name.text)) return;
    if (call.expression.name.text === 'insertText' && !isKeyboardCall(call)) return;
    const v = valueArg(call);
    if (!isStringLike(v)) return;
    const nv = otherValue(v.text, hash(v.getStart(sf)));
    sites.push(site(sf, call, [setLit(sf, v, nv)], `input "${v.text}" -> "${nv}"`));
  });
  return sites;
};

const ALPHA = 'abcdefghijklmnopqrstuvwxyz';

function amplify(v: string, k: number): { value: string; how: string } {
  const chars = Array.from(v);
  const op = chars.length ? k % 3 : 1;
  const pos = chars.length ? (k >>> 4) % chars.length : 0;
  let c = ALPHA[(k >>> 10) % ALPHA.length];
  if (op === 0) {
    chars.splice(pos, 1);
    return { value: chars.join(''), how: `remove char ${pos}` };
  }
  if (op === 1) {
    const at = chars.length ? (k >>> 4) % (chars.length + 1) : 0;
    chars.splice(at, 0, c);
    return { value: chars.join(''), how: `add "${c}" at ${at}` };
  }
  if (chars[pos] === c) c = ALPHA[(ALPHA.indexOf(c) + 1) % ALPHA.length];
  chars[pos] = c;
  return { value: chars.join(''), how: `replace char ${pos} by "${c}"` };
}

const stringAmplify: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const call = memberCall(n);
    if (!call || !STEP_METHODS.has(call.expression.name.text)) return;
    for (const a of call.arguments) {
      if (!isStringLike(a)) continue;
      const r = amplify(a.text, hash(a.getStart(sf), 7));
      sites.push(site(sf, call, [setLit(sf, a, r.value)], `"${a.text}" -> "${r.value}" (${r.how})`));
    }
  });
  return sites;
};

const numberAmplify: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const call = memberCall(n);
    if (!call) return;
    if (!STEP_METHODS.has(call.expression.name.text) && !asMatcherCall(call)) return;
    for (const a of call.arguments) {
      if (!ts.isNumericLiteral(a)) continue;
      const v = Number(a.text);
      const seen = new Set<string>([fmt(v)]);
      for (const nv of [v + 1, v - 1, 0]) {
        const t = fmt(nv);
        if (seen.has(t)) continue;
        seen.add(t);
        sites.push(site(sf, call, [replace(sf, a, t)], `${a.text} -> ${t}`));
      }
    }
  });
  return sites;
};

const BOOL_OPTION_CALLS = new Set([...STEP_METHODS, ...GET_BY, 'locator', 'filter']);

const boolNegate: Finder = (sf) => {
  const sites: Site[] = [];
  const isBool = (e: ts.Node) => e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword;
  visit(sf, (n) => {
    const call = memberCall(n);
    if (!call) return;
    const name = call.expression.name.text;
    if (!BOOL_OPTION_CALLS.has(name)) return;
    for (const a of call.arguments) {
      if (name === 'setChecked' && isBool(a)) {
        const t = a.kind === ts.SyntaxKind.TrueKeyword ? 'false' : 'true';
        sites.push(site(sf, call, [replace(sf, a, t)], `setChecked(${a.getText(sf)}) -> setChecked(${t})`));
      }
      if (!ts.isObjectLiteralExpression(a)) continue;
      for (const p of a.properties) {
        if (!ts.isPropertyAssignment(p) || !isBool(p.initializer)) continue;
        const t = p.initializer.kind === ts.SyntaxKind.TrueKeyword ? 'false' : 'true';
        sites.push(site(sf, call, [replace(sf, p.initializer, t)], `${name}: ${propName(p)}: ${p.initializer.getText(sf)} -> ${t}`));
      }
    }
  });
  return sites;
};

const checkToggle: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const call = memberCall(n);
    if (!call) return;
    const name = call.expression.name.text;
    if (name !== 'check' && name !== 'uncheck') return;
    const to = name === 'check' ? 'uncheck' : 'check';
    sites.push(site(sf, call, [replace(sf, call.expression.name, to)], `${name}() -> ${to}()`));
  });
  return sites;
};

const selectChange: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const call = memberCall(n);
    if (!call || call.expression.name.text !== 'selectOption') return;
    const v = valueArg(call);
    if (!isStringLike(v) || v.text === '') return;
    sites.push(site(sf, call, [setLit(sf, v, '')], `selectOption("${v.text}") -> selectOption("")`));
  });
  return sites;
};

const inputEmpty: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const call = memberCall(n);
    if (!call || call.expression.name.text !== 'fill' || isKeyboardCall(call)) return;
    const v = valueArg(call);
    if (!v || (isStringLike(v) && v.text === '')) return;
    const q = isStringLike(v) ? quote(v.getText(sf), '') : "''";
    sites.push(site(sf, call, [replace(sf, v, q)], `fill(${v.getText(sf).slice(0, 40)}) -> fill('')`));
  });
  return sites;
};

/* ------------------------------------------------------- TOR test oracles */

const closeToAdd: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const m = matcher(n, ['toBe']);
    if (!m || m.call.arguments.length !== 1 || !isNumberLiteral(m.call.arguments[0])) return;
    const v = m.call.arguments[0].getText(sf);
    sites.push(site(sf, m.call, [matcherTail(sf, m, `toBeCloseTo(${v}, 0)`)], `toBe(${v}) -> toBeCloseTo(${v}, 0)`));
  });
  return sites;
};

function closeToDigits(delta: 1 | -1): Finder {
  return (sf, p) => {
    const def = Number(p.defaultDigits ?? 2);
    const sites: Site[] = [];
    visit(sf, (n) => {
      const m = matcher(n, ['toBeCloseTo']);
      if (!m || !m.call.arguments.length) return;
      const [x, d] = m.call.arguments;
      let edit: TextEdit;
      let desc: string;
      if (!d) {
        const nd = def + delta;
        edit = { start: x.end, end: x.end, text: `, ${nd}` };
        desc = `toBeCloseTo digits ${def} (default) -> ${nd}`;
      } else if (isNumberLiteral(d)) {
        const nd = Number(d.getText(sf).replace(/\s+/g, '')) + delta;
        edit = replace(sf, d, String(nd));
        desc = `toBeCloseTo digits ${d.getText(sf)} -> ${nd}`;
      } else {
        edit = replace(sf, d, `(${d.getText(sf)}) ${delta > 0 ? '+' : '-'} 1`);
        desc = `toBeCloseTo digits ${d.getText(sf)} ${delta > 0 ? '+' : '-'} 1`;
      }
      sites.push(site(sf, m.call, [edit], desc));
    });
    return sites;
  };
}

const closeToRemove: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const m = matcher(n, ['toBeCloseTo']);
    if (!m || !m.call.arguments.length) return;
    const x = m.call.arguments[0].getText(sf);
    sites.push(site(sf, m.call, [matcherTail(sf, m, `toBe(${x})`)], `toBeCloseTo(${x}, …) -> toBe(${x})`));
  });
  return sites;
};

const BOOL_PAIRS: Record<string, string> = {
  toBeTruthy: 'toBeFalsy', toBeFalsy: 'toBeTruthy', toBeVisible: 'toBeHidden', toBeHidden: 'toBeVisible',
  toBeEnabled: 'toBeDisabled', toBeDisabled: 'toBeEnabled',
};

const boolSwap: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const m = asMatcherCall(n);
    if (!m) return;
    const to = BOOL_PAIRS[m.name];
    if (to) {
      sites.push(site(sf, m.call, [replace(sf, m.access.name, to)], `${m.notAccess ? 'not.' : ''}${m.name} -> ${m.notAccess ? 'not.' : ''}${to}`));
    } else if (m.name === 'toBeChecked') {
      const edit: TextEdit = m.notAccess
        ? { start: m.expectCall.end, end: m.notAccess.end, text: '' }
        : { start: m.expectCall.end, end: m.expectCall.end, text: '.not' };
      sites.push(site(sf, m.call, [edit], m.notAccess ? 'not.toBeChecked -> toBeChecked' : 'toBeChecked -> not.toBeChecked'));
    }
  });
  return sites;
};

const expectFailure: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    if (!ts.isExpressionStatement(n) || !ts.isCallExpression(n.expression)) return;
    const call = n.expression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== 'test') return;
    const args = call.arguments;
    const fn = args[args.length - 1];
    if (args.length < 2 || !isStringLike(args[0]) && !ts.isTemplateExpression(args[0])) return;
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return;
    sites.push(site(sf, call, [{ start: call.expression.end, end: call.expression.end, text: '.fail' }], `test(${args[0].getText(sf).slice(0, 40)}) -> test.fail(…)`));
  });
  return sites;
};

const ONE_SHOT_BOOL: Record<string, string> = {
  toBeVisible: 'isVisible', toBeHidden: 'isHidden', toBeEnabled: 'isEnabled', toBeDisabled: 'isDisabled', toBeChecked: 'isChecked', toBeEditable: 'isEditable',
};

/** Options object of a web assertion that only holds keys in `allowed` (or no options). */
function optsOnly(o: ts.Expression | undefined, allowed: string[]): ts.ObjectLiteralExpression | null | false {
  if (!o) return null;
  if (!ts.isObjectLiteralExpression(o)) return false;
  return o.properties.every((p) => ts.isPropertyAssignment(p) && allowed.includes(propName(p) || '')) ? o : false;
}

function hasTrue(o: ts.ObjectLiteralExpression | null, key: string): boolean {
  return !!o && o.properties.some((p) => ts.isPropertyAssignment(p) && propName(p) === key && p.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

/** Expected-value text for a string/regex oracle: [matcher, expected] or null if unsupported. */
function expected(sf: ts.SourceFile, e: ts.Expression | undefined, normalise: boolean): [string, string] | null {
  if (!e) return null;
  if (ts.isRegularExpressionLiteral(e)) return ['toMatch', e.getText(sf)];
  if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e) || ts.isNumericLiteral(e)) return null;
  if (isStringLike(e)) return ['toBe', normalise ? quote(e.getText(sf), e.text.replace(/\s+/g, ' ').trim()) : e.getText(sf)];
  return ['toBe', e.getText(sf)];
}

const assertOneShot: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const m = asMatcherCall(n);
    if (!m || !m.call.parent || !ts.isAwaitExpression(m.call.parent)) return;
    const callee = m.expectCall.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text !== 'soft') return; // expect.poll is already one-shot polling
    const target = m.expectCall.arguments[0];
    if (!target || m.expectCall.arguments.length !== 1) return;
    const ex = callee.getText(sf);
    const not = m.notAccess ? '.not' : '';
    const L = wrap(sf, target);
    const args = m.call.arguments;
    let text: string | null = null;
    const getter = ONE_SHOT_BOOL[m.name];
    if (getter) {
      if (args.length > 1 || optsOnly(args[0], ['timeout']) === false) return;
      text = `${ex}(await ${L}.${getter}())${not}.toBe(true)`;
    } else if (m.name === 'toHaveText' || m.name === 'toContainText') {
      const opts = optsOnly(args[1], ['timeout', 'useInnerText']);
      if (opts === false || args.length > 2) return;
      const exp = expected(sf, args[0], true);
      if (!exp) return;
      const actual = hasTrue(opts, 'useInnerText') ? `(await ${L}.innerText())` : `((await ${L}.textContent()) ?? '')`;
      const mat = m.name === 'toContainText' && exp[0] === 'toBe' ? 'toContain' : exp[0];
      text = `${ex}(${actual}.replace(/\\s+/g, ' ').trim())${not}.${mat}(${exp[1]})`;
    } else if (m.name === 'toHaveValue') {
      if (args.length > 2 || optsOnly(args[1], ['timeout']) === false) return;
      const exp = expected(sf, args[0], false);
      if (!exp) return;
      text = `${ex}(await ${L}.inputValue())${not}.${exp[0]}(${exp[1]})`;
    } else if (m.name === 'toHaveCount') {
      if (args.length > 2 || !args[0] || optsOnly(args[1], ['timeout']) === false) return;
      if (ts.isStringLiteral(args[0]) || ts.isRegularExpressionLiteral(args[0])) return;
      text = `${ex}(await ${L}.count())${not}.toBe(${args[0].getText(sf)})`;
    } else if (m.name === 'toHaveURL') {
      if (!isPageRoot(rootIdentifier(target)) || args.length > 2 || optsOnly(args[1], ['timeout']) === false) return;
      const exp = expected(sf, args[0], false);
      if (!exp) return;
      const a0 = args[0];
      if (isStringLike(a0) && !/^[a-z][\w+.-]*:/i.test(a0.text)) {
        // relative URL (resolved against baseURL by toHaveURL): compare the suffix
        text = `${ex}(${L}.url().endsWith(${a0.getText(sf)}))${not}.toBe(true)`;
      } else {
        text = `${ex}(${L}.url())${not}.${exp[0]}(${exp[1]})`;
      }
    }
    if (!text) return;
    sites.push(site(sf, m.call, [replace(sf, m.call, text)], `${m.name}: auto-retrying assertion -> one-shot check`));
  });
  return sites;
};

/* ------------------------------------------------------------ TTO timeouts */

const TIMEOUT_SETTERS = new Set(['setTimeout', 'setDefaultTimeout', 'setDefaultNavigationTimeout']);

/** Numeric timeouts: `timeout: n` properties and `x.setTimeout(n)` / `setDefaultTimeout(n)` calls. */
function timeoutLiterals(sf: ts.SourceFile): { lit: ts.NumericLiteral; node: ts.Node; what: string }[] {
  const out: { lit: ts.NumericLiteral; node: ts.Node; what: string }[] = [];
  visit(sf, (n) => {
    if (ts.isPropertyAssignment(n) && propName(n) === 'timeout' && ts.isNumericLiteral(n.initializer)) {
      out.push({ lit: n.initializer, node: n, what: 'timeout:' });
      return;
    }
    const call = memberCall(n);
    if (call && TIMEOUT_SETTERS.has(call.expression.name.text) && call.arguments.length === 1 && ts.isNumericLiteral(call.arguments[0])) {
      out.push({ lit: call.arguments[0], node: call, what: `${call.expression.name.text}()` });
    }
  });
  return out;
}

function timeoutScale(dir: 'decrease' | 'increase'): Finder {
  return (sf, p) => {
    const factor = Number(p.factor ?? 10);
    const sites: Site[] = [];
    for (const t of timeoutLiterals(sf)) {
      const v = Number(t.lit.text);
      if (v <= 0) continue; // 0 = no timeout
      const nv = dir === 'decrease' ? Math.max(1, Math.round(v / factor)) : Math.round(v * factor);
      if (nv === v) continue;
      sites.push(site(sf, t.node, [replace(sf, t.lit, String(nv))], `${t.what} ${v} -> ${nv}`));
    }
    return sites;
  };
}

const timeoutRemove: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    for (const p of n.properties) {
      if (propName(p) !== 'timeout' || !(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) continue;
      const edit = filterObject(sf, n, (name) => name !== 'timeout');
      if (edit) sites.push(site(sf, p, [edit], `remove ${p.getText(sf).slice(0, 40)}`));
      return; // one site per object
    }
  });
  return sites;
};

/* ------------------------------------------------------------ TWS waits */

function waitScale(zero: boolean): Finder {
  return (sf, p) => {
    const divisor = Number(p.divisor ?? 2);
    const sites: Site[] = [];
    visit(sf, (n) => {
      const call = memberCall(n);
      if (!call || call.expression.name.text !== 'waitForTimeout' || call.arguments.length !== 1) return;
      const a = call.arguments[0];
      let t: string;
      if (ts.isNumericLiteral(a)) {
        const v = Number(a.text);
        const nv = zero ? 0 : Math.floor(v / divisor);
        if (nv === v) return;
        t = String(nv);
      } else {
        t = zero ? '0' : `(${a.getText(sf)}) / ${divisor}`;
      }
      sites.push(site(sf, call, [replace(sf, a, t)], `waitForTimeout(${a.getText(sf)}) -> waitForTimeout(${t})`));
    });
    return sites;
  };
}

/* ------------------------------------------------------------ TDG dialogs */

const LISTEN = new Set(['on', 'once', 'addListener', 'prependListener', 'waitForEvent']);

function isDialogListener(call: ts.CallExpression): boolean {
  const name = methodName(call);
  const a0 = call.arguments[0];
  return !!name && LISTEN.has(name) && ts.isPropertyAccessExpression(call.expression) && isStringLike(a0) && a0.text === 'dialog';
}

const dialogSwap: Finder = (sf) => {
  const names = new Set<string>();
  visit(sf, (n) => {
    if (!ts.isCallExpression(n) || !isDialogListener(n)) return;
    const fn = n.arguments[1];
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name)) names.add(fn.parameters[0].name.text);
    // const d = await page.waitForEvent('dialog')
    let p: ts.Node = n.parent;
    while (p && (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) names.add(p.name.text);
  });
  const sites: Site[] = [];
  visit(sf, (n) => {
    const call = memberCall(n);
    if (!call) return;
    const name = call.expression.name.text;
    if (name !== 'accept' && name !== 'dismiss') return;
    const root = rootIdentifier(call.expression.expression);
    if (!root || !(names.has(root) || /dialog/i.test(root))) return;
    const to = name === 'accept' ? 'dismiss' : 'accept';
    sites.push(site(sf, call, [{ start: call.expression.name.getStart(sf), end: call.end, text: `${to}()` }], `dialog.${name}() -> dialog.${to}()`));
  });
  return sites;
};

const handlerRemove: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    if (!ts.isExpressionStatement(n)) return;
    const call = unwrap(n.expression);
    if (!ts.isCallExpression(call) || !isDialogListener(call) || methodName(call) === 'waitForEvent') return;
    sites.push(site(sf, n, [replace(sf, n, comment(`TDG removed: ${methodName(call)}('dialog') handler`))], `remove ${methodName(call)}('dialog', …) handler`));
  });
  return sites;
};

/* ------------------------------------------------------------- TEV events */

const HOVER_OPTIONS = ['force', 'modifiers', 'noWaitAfter', 'position', 'timeout', 'trial', 'strict'];

function clickTo(to: 'hover' | 'dblclick'): Finder {
  return (sf) => {
    const sites: Site[] = [];
    visit(sf, (n) => {
      const call = memberCall(n);
      if (!call || call.expression.name.text !== 'click') return;
      if (to === 'hover' && receiverName(call) === 'mouse') return; // mouse.hover does not exist
      const edits: TextEdit[] = [replace(sf, call.expression.name, to)];
      const last = call.arguments[call.arguments.length - 1];
      if (last && ts.isObjectLiteralExpression(last)) {
        const e = filterObject(sf, last, (k) => (to === 'hover' ? !!k && HOVER_OPTIONS.includes(k) : k !== 'clickCount'));
        if (e) edits.push(e);
      }
      sites.push(site(sf, call, edits, `click() -> ${to}()`));
    });
    return sites;
  };
}

/* ------------------------------------------------------------ TLC locators */

const idClassSwap: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const lit = selectorLiteral(n);
    if (!lit) return;
    const css = cssParts(lit.text);
    if (!css) return;
    const tok = firstIdOrClass(css.body);
    if (!tok) return;
    const other = tok.sym === '#' ? '.' : '#';
    const body = css.body.slice(0, tok.index) + other + css.body.slice(tok.index + 1);
    const value = css.prefix + body;
    sites.push(site(sf, n, [setLit(sf, lit, value)], `selector "${lit.text}" -> "${value}"`));
  });
  return sites;
};

const idMutate: Finder = (sf, p) => {
  const suffix = String(p.suffix ?? '_mut');
  const sites: Site[] = [];
  visit(sf, (n) => {
    const call = memberCall(n);
    if (!call) return;
    if (call.expression.name.text === 'getByTestId') {
      const a = call.arguments[0];
      if (isStringLike(a)) sites.push(site(sf, call, [setLit(sf, a, a.text + suffix)], `getByTestId("${a.text}") -> "${a.text + suffix}"`));
      return;
    }
    const lit = selectorLiteral(call);
    if (!lit) return;
    const sel = lit.text;
    let value: string | null = null;
    const engine = sel.match(/^\s*(id|data-testid)=(.+)$/);
    if (engine) value = sel.replace(/\s*$/, '') + suffix;
    const css = engine ? null : cssParts(sel);
    if (css) {
      const tok = firstIdOrClass(css.body, '#');
      if (tok) {
        const at = tok.index + 1 + tok.ident.length;
        value = css.prefix + css.body.slice(0, at) + suffix + css.body.slice(at);
      } else {
        const re = /(\[\s*(?:id|data-testid)\s*=\s*)("[^"]*"|'[^']*'|[^\]\s]+)/;
        if (re.test(css.body)) {
          value = css.prefix + css.body.replace(re, (_all, pre: string, v: string) =>
            v[0] === '"' || v[0] === "'" ? pre + v.slice(0, -1) + suffix + v.slice(-1) : pre + v + suffix);
        }
      }
    }
    if (value === null || value === sel) return;
    sites.push(site(sf, call, [setLit(sf, lit, value)], `id selector "${sel}" -> "${value}"`));
  });
  return sites;
};

const nthShift: Finder = (sf, p) => {
  const offset = Number(p.offset ?? 1);
  const sites: Site[] = [];
  visit(sf, (n) => {
    const call = memberCall(n);
    if (!call) return;
    const name = call.expression.name.text;
    if (name === 'nth' && call.arguments.length === 1) {
      const a = call.arguments[0];
      const t = ts.isNumericLiteral(a) ? String(Number(a.text) + offset) : `(${a.getText(sf)}) + ${offset}`;
      sites.push(site(sf, call, [replace(sf, a, t)], `nth(${a.getText(sf)}) -> nth(${t})`));
    } else if ((name === 'first' || name === 'last') && call.arguments.length === 0) {
      const to = name === 'first' ? 'last' : 'first';
      sites.push(site(sf, call, [replace(sf, call.expression.name, to)], `${name}() -> ${to}()`));
    }
  });
  return sites;
};

const NAME_GETTERS = new Set(['getByText', 'getByLabel', 'getByPlaceholder', 'getByTitle', 'getByAltText']);

const nameMutate: Finder = (sf, p) => {
  const suffix = String(p.suffix ?? 'Mut');
  const sites: Site[] = [];
  visit(sf, (n) => {
    const call = memberCall(n);
    if (!call) return;
    const name = call.expression.name.text;
    let target: ts.Expression | undefined;
    if (NAME_GETTERS.has(name)) target = call.arguments[0];
    else if (name === 'getByRole') {
      const o = call.arguments[1];
      const prop = o && ts.isObjectLiteralExpression(o) ? o.properties.find((pr) => propName(pr) === 'name') : undefined;
      if (prop && ts.isPropertyAssignment(prop)) target = prop.initializer;
      else if (prop && ts.isShorthandPropertyAssignment(prop)) {
        sites.push(site(sf, call, [replace(sf, prop, `name: \`\${name}${suffix}\``)], `${name} name -> name + "${suffix}"`));
        return;
      }
    }
    if (!target) return;
    const e = appendSuffix(sf, target, suffix);
    if (!e) return;
    sites.push(site(sf, call, [e], `${name} ${target.getText(sf).slice(0, 40)} -> + "${suffix}"`));
  });
  return sites;
};

/* ------------------------------------------------------------- TSS session */

const cookiesClear: Finder = (sf) => {
  const sites: Site[] = [];
  visit(sf, (n) => {
    const a = actionStatement(n);
    if (!a || !siblings(a.stmt)) return;
    const root = rootIdentifier(a.call);
    if (!isPageRoot(root)) return;
    const start = a.stmt.getStart(sf);
    sites.push(site(sf, a.stmt, [{ start, end: start, text: `await ${root}.context().clearCookies();\n${indentAt(sf, start)}` }], `clear cookies before ${a.name}()`));
  });
  return sites;
};

/* ============================================================ definitions */

const STEP = 'Test Step Mutations';
const DATA = 'Test Data Mutations';
const ORACLE = 'Test Oracle Mutations';
const TIMEOUT = 'Test Timeout Mutations';
const WAIT = 'Test Wait Mutations';
const DIALOG = 'Test Dialog Mutations';
const EVENT = 'Test Event Mutations';
const LOCATOR = 'Test Locator Mutations';
const SESSION = 'Test Session Mutations';

export const TEST_LIT_OPERATORS: OperatorDef[] = [
  testOp({ id: 'TST.step.remove', category: STEP, intent: 'A test step (an awaited action or navigation) is missing from the script.', refs: ['Almeida19', 'Danglot19'], aliases: ['Almeida19:RemoveStep', 'Danglot19:MethodRemove'], findSites: stepRemove }),
  testOp({ id: 'TST.step.swap', category: STEP, intent: 'Two consecutive test steps are performed in the wrong order.', refs: ['Almeida19'], aliases: ['Almeida19:ChangeOrder'], findSites: stepSwap }),
  testOp({ id: 'TST.step.duplicate', category: STEP, intent: 'A test step is performed twice.', refs: ['Danglot19'], aliases: ['Danglot19:MethodDuplication'], findSites: stepDuplicate }),
  testOp({ id: 'TST.step.addBack', category: STEP, intent: 'The user navigates back after a click and repeats it (back-button navigation).', refs: ['Almeida19'], aliases: ['Almeida19:AddBack'], findSites: stepAddBack }),
  testOp({ id: 'TST.step.refill', category: STEP, intent: 'A previously filled field is filled again with a different value after the next field.', refs: ['Almeida19'], aliases: ['Almeida19:AddStep'], defaults: { suffix: 'Mut' }, findSites: stepRefill }),

  testOp({ id: 'TDT.input.change', category: DATA, intent: 'The test types a different (but plausible) input value.', refs: ['Almeida19', 'Hammoudi16'], aliases: ['Almeida19:ChangeInputData', 'Hammoudi16:values'], findSites: inputChange }),
  testOp({ id: 'TDT.string.amplify', category: DATA, intent: 'A string argument of a test action has one character removed, added or replaced.', refs: ['Danglot19'], aliases: ['Danglot19:StringLiteralAmplifier'], findSites: stringAmplify }),
  testOp({ id: 'TDT.number.amplify', category: DATA, intent: 'A numeric argument of a test action or assertion is off by one or zero.', refs: ['Danglot19'], aliases: ['Danglot19:NumberLiteralAmplifier'], findSites: numberAmplify }),
  testOp({ id: 'TDT.bool.negate', category: DATA, intent: 'A boolean option of a test action or locator is negated.', refs: ['Danglot19'], aliases: ['Danglot19:BooleanLiteralAmplifier'], findSites: boolNegate }),
  testOp({ id: 'TDT.check.toggle', category: DATA, intent: 'The test checks a box it should uncheck (or vice versa).', refs: ['Danglot19', 'Hammoudi16'], aliases: ['Hammoudi16:values'], findSites: checkToggle }),
  testOp({ id: 'TDT.select.change', category: DATA, intent: 'The test selects a different option (the empty-value option).', refs: ['Hammoudi16'], aliases: ['Hammoudi16:values'], findSites: selectChange }),
  testOp({ id: 'TDT.input.empty', category: DATA, intent: 'The test leaves an input empty.', refs: ['Danglot19'], aliases: ['Danglot19:NullifierAmplifier'], findSites: inputEmpty }),

  testOp({ id: 'TOR.closeTo.add', category: ORACLE, intent: 'An exact numeric oracle is weakened to an approximate one.', refs: ['Maciel17'], aliases: ['Maciel17:ATV'], findSites: closeToAdd }),
  testOp({ id: 'TOR.closeTo.tighten', category: ORACLE, intent: 'The tolerance of an approximate numeric oracle is decreased.', refs: ['Maciel17'], aliases: ['Maciel17:DCfTV'], defaults: { defaultDigits: 2 }, findSites: closeToDigits(1) }),
  testOp({ id: 'TOR.closeTo.loosen', category: ORACLE, intent: 'The tolerance of an approximate numeric oracle is increased.', refs: ['Maciel17'], aliases: ['Maciel17:ICfTV'], defaults: { defaultDigits: 2 }, findSites: closeToDigits(-1) }),
  testOp({ id: 'TOR.closeTo.remove', category: ORACLE, intent: 'The tolerance of an approximate numeric oracle is removed (exact comparison).', refs: ['Maciel17'], aliases: ['Maciel17:RTV'], findSites: closeToRemove }),
  testOp({ id: 'TOR.bool.swap', category: ORACLE, intent: 'A boolean-state oracle expects the opposite state.', refs: ['Maciel17'], aliases: ['Maciel17:RBA'], findSites: boolSwap }),
  testOp({ id: 'TOR.expect.failure', category: ORACLE, intent: 'The test is marked as expected to fail.', refs: ['Maciel17', 'Playwright'], aliases: ['Maciel17:AEC'], findSites: expectFailure }),
  testOp({ id: 'TOR.assert.oneShot', category: ORACLE, intent: 'An auto-retrying web assertion is replaced by a one-shot check (async wait flakiness).', refs: ['Romano21', 'Playwright'], aliases: ['Romano21:AsyncWait'], findSites: assertOneShot }),

  testOp({ id: 'TTO.timeout.decrease', category: TIMEOUT, intent: 'A test/action timeout is too short.', refs: ['Maciel17'], aliases: ['Maciel17:DCfT'], defaults: { factor: 10 }, findSites: timeoutScale('decrease') }),
  testOp({ id: 'TTO.timeout.increase', category: TIMEOUT, intent: 'A test/action timeout is too long.', refs: ['Maciel17'], aliases: ['Maciel17:ICfT'], defaults: { factor: 10 }, findSites: timeoutScale('increase') }),
  testOp({ id: 'TTO.timeout.remove', category: TIMEOUT, intent: 'An explicit timeout option is missing (the default applies).', refs: ['Maciel17'], aliases: ['Maciel17:RTA'], findSites: timeoutRemove }),

  testOp({ id: 'TWS.wait.shrink', category: WAIT, intent: 'A fixed sleep is too short.', refs: ['Pei23'], aliases: ['Pei23:TRaf'], defaults: { divisor: 2 }, findSites: waitScale(false) }),
  testOp({ id: 'TWS.wait.zero', category: WAIT, intent: 'A fixed sleep is removed (zero wait).', refs: ['Liu24'], aliases: ['Liu24:WEFix'], findSites: waitScale(true) }),

  testOp({ id: 'TDG.dialog.swap', category: DIALOG, intent: 'The test dismisses a dialog it should accept (or vice versa).', refs: ['Hammoudi16'], aliases: ['Hammoudi16:popups'], findSites: dialogSwap }),
  testOp({ id: 'TDG.handler.remove', category: DIALOG, intent: 'The test no longer handles a dialog (Playwright then dismisses it).', refs: ['Hammoudi16'], aliases: ['Hammoudi16:popups'], findSites: handlerRemove }),

  testOp({ id: 'TEV.click.toHover', category: EVENT, intent: 'The test hovers an element instead of clicking it.', refs: ['Nishiura13'], aliases: ['Nishiura13:EventTypeRA'], findSites: clickTo('hover') }),
  testOp({ id: 'TEV.click.toDblclick', category: EVENT, intent: 'The test double-clicks an element instead of clicking it.', refs: ['Nishiura13'], aliases: ['Nishiura13:EventTypeRA'], findSites: clickTo('dblclick') }),

  testOp({ id: 'TLC.css.idClassSwap', category: LOCATOR, intent: 'A CSS locator confuses an id with a class.', refs: ['Mirshokraie15'], aliases: ['Mirshokraie15:jQ-1'], findSites: idClassSwap }),
  testOp({ id: 'TLC.id.mutate', category: LOCATOR, intent: 'An id/test-id based locator refers to a changed id.', refs: ['LinaresVasquez17', 'Hammoudi16'], aliases: ['LinaresVasquez17:InvalidIDFindView', 'Hammoudi16:attribute locators'], defaults: { suffix: '_mut' }, findSites: idMutate }),
  testOp({ id: 'TLC.nth.shift', category: LOCATOR, intent: 'A positional locator selects a neighbouring element.', refs: ['Hammoudi16'], aliases: ['Hammoudi16:structural locators'], defaults: { offset: 1 }, findSites: nthShift }),
  testOp({ id: 'TLC.name.mutate', category: LOCATOR, intent: 'A text/label/accessible-name locator refers to changed text.', refs: ['Hammoudi16'], aliases: ['Hammoudi16:attribute locators'], defaults: { suffix: 'Mut' }, findSites: nameMutate }),

  testOp({ id: 'TSS.cookies.clear', category: SESSION, intent: 'The user session expires (cookies cleared) before a test step.', refs: ['Hammoudi16'], aliases: ['Hammoudi16:userSession'], findSites: cookiesClear }),
];
