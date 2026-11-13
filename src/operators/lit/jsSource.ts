/**
 * Batch F: application JavaScript rewriting (StrykerJS, Mutode, Mutandis,
 * Angular operators of Augustin et al.).
 *
 * Every operator is a page-scope DOM operator with `perResource: 'script'`:
 * one mutant per external script of a page and `variants` mutants per script.
 * `nodeApply` routes the script URL, parses the served body with the
 * TypeScript compiler (JS script kind), lists the operator's sites with a
 * pure site-finder (`JS_SITE_FINDERS`), applies the site picked by
 * `sites[(hash32(url + id) + variant * 7919) % sites.length]` and fulfils the
 * rewritten body.
 *
 * Site-finders are pure `(sf, ts) => JsEdit[]` functions (one edit per site,
 * source order), so they are unit-testable on JS strings (`mutateJs`).
 */
import * as vm from 'vm';
import * as ts from 'typescript';
import type { BrowserContext, Request, Route } from '@playwright/test';
import type { DomNodeContext, OperatorDef } from '../registry';
import { hash32 } from '../../util/random';
import { domOp } from './util';

/* ================================================================== types */

/** One mutation site: replace `[start, end)` of the source with `text`. */
export interface JsEdit {
  start: number;
  end: number;
  text: string;
}

export type JsSiteFinder = (sf: ts.SourceFile, t: typeof ts) => JsEdit[];

export interface JsMutationResult {
  code: string;
  edit: JsEdit;
  /** `<op> at <line>:<col>: <before> → <after>` */
  detail: string;
  siteCount: number;
  siteIndex: number;
}

export interface JsMutateOptions {
  /** Node budget of the site enumeration (default 50 000). */
  maxNodes?: number;
  /** Re-check the mutated code for syntax errors (V8, or TS for modules). Default true. */
  verify?: boolean;
  /** Pre-parsed source (skips parsing). */
  sourceFile?: ts.SourceFile;
}

export const DEFAULT_MAX_NODES = 50_000;

/* ================================================================ helpers */

const K = ts.SyntaxKind;

/** Visit nodes in source order, at most `max` of them. */
function walk(sf: ts.SourceFile, max: number, cb: (n: ts.Node) => void): void {
  let count = 0;
  const go = (n: ts.Node): void => {
    if (count++ >= max) return;
    cb(n);
    n.forEachChild(go);
  };
  sf.forEachChild(go);
}

/** Node budget for the finder currently running (set by findJsSites). */
let budget = DEFAULT_MAX_NODES;

/** Build a finder from a per-node callback. */
function finder(cb: (n: ts.Node, sf: ts.SourceFile, out: JsEdit[]) => void): JsSiteFinder {
  return (sf) => {
    const out: JsEdit[] = [];
    walk(sf, budget, (n) => cb(n, sf, out));
    return out;
  };
}

const txt = (sf: ts.SourceFile, n: ts.Node) => sf.text.slice(n.getStart(sf), n.end);
const replaceNode = (sf: ts.SourceFile, n: ts.Node, text: string): JsEdit => ({ start: n.getStart(sf), end: n.end, text });

function parenthesize(sf: ts.SourceFile, n: ts.Node): string {
  return n.kind === K.ParenthesizedExpression || isPrimary(n) ? txt(sf, n) : `(${txt(sf, n)})`;
}
function isPrimary(n: ts.Node): boolean {
  return (
    ts.isIdentifier(n) || ts.isLiteralExpression(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) ||
    ts.isCallExpression(n) || n.kind === K.ThisKeyword || n.kind === K.TrueKeyword || n.kind === K.FalseKeyword ||
    n.kind === K.NullKeyword || ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n)
  );
}

/** Array/object literal used as a destructuring target (`[a, b] = x`, `for ({a} of xs)`). */
function isAssignmentPattern(n: ts.Node): boolean {
  let c: ts.Node = n;
  let p = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) ||
    ts.isObjectLiteralExpression(p) || ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p))) {
    if (ts.isPropertyAssignment(p) && p.name === c) return false;
    c = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === K.EqualsToken && p.left === c) return true;
  if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === c) return true;
  return false;
}

/** Last operand of a webpack-style indirect callee `(0, x.take)` and plain callees. */
function calleeName(e: ts.Expression): string | null {
  while (ts.isParenthesizedExpression(e)) {
    e = e.expression;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === K.CommaToken) e = e.right;
  }
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name.text;
  return null;
}

function memberCall(n: ts.Node): { call: ts.CallExpression; recv: ts.Expression; name: string } | null {
  if (!ts.isCallExpression(n)) return null;
  const e = n.expression;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return { call: n, recv: e.expression, name: e.name.text };
  return null;
}

/**
 * Remove item `skip` of a comma-separated list: delete from the item to the
 * next one (or from the previous item's end for the last item). O(1) per
 * site, so huge array literals in bundles stay cheap.
 */
function listWithout(sf: ts.SourceFile, items: readonly ts.Node[], skip: number): JsEdit {
  const it = items[skip];
  if (items.length === 1) return { start: it.getStart(sf), end: it.end, text: '' };
  if (skip < items.length - 1) return { start: it.getStart(sf), end: items[skip + 1].getStart(sf), text: '' };
  return { start: items[skip - 1].end, end: it.end, text: '' };
}

function isStringish(n: ts.Node): boolean {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);
}

/** String literals that must not be touched: module specifiers, require(), directives, keys. */
function isProtectedString(n: ts.Node): boolean {
  const p = n.parent;
  if (!p) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isImportTypeNode(p)) return true;
  if (ts.isCallExpression(p) && (p.expression.kind === K.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === 'require'))) return true;
  if (ts.isExpressionStatement(p) && ts.isStringLiteral(n) && isPrologue(p)) return true;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === n) return true;
  if (ts.isImportAttribute?.(p)) return true;
  return false;
}
function isPrologue(stmt: ts.ExpressionStatement): boolean {
  const block = stmt.parent as ts.Block | ts.SourceFile;
  const stmts = (block as ts.Block).statements;
  if (!stmts) return false;
  for (const s of stmts) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) return false;
    if (s === stmt) return true;
  }
  return false;
}

const RESERVED = new Set(
  ('break case catch class const continue debugger default delete do else enum export extends false finally for function if ' +
    'import in instanceof new null return super switch this throw true try typeof var void while with yield let static ' +
    'implements interface package private protected public await arguments eval').split(' '),
);

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);
}

function hasSuperCall(body: ts.Block): boolean {
  return body.statements.some((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.kind === K.SuperKeyword);
}

const tokenEdit = (sf: ts.SourceFile, tok: ts.Node, text: string): JsEdit => ({ start: tok.getStart(sf), end: tok.end, text });

function binaryOpFinder(map: Partial<Record<ts.SyntaxKind, string>>, skip?: (b: ts.BinaryExpression) => boolean): JsSiteFinder {
  return finder((n, sf, out) => {
    if (!ts.isBinaryExpression(n)) return;
    const rep = map[n.operatorToken.kind];
    if (rep === undefined || skip?.(n)) return;
    out.push(tokenEdit(sf, n.operatorToken, rep));
  });
}

const isStringConcat = (b: ts.BinaryExpression) => isStringish(b.left) || isStringish(b.right);

function logicalOperand(sf: ts.SourceFile, e: ts.Expression): string {
  const k = ts.isBinaryExpression(e) ? e.operatorToken.kind : null;
  return k === K.AmpersandAmpersandToken || k === K.BarBarToken || k === K.QuestionQuestionToken ? `(${txt(sf, e)})` : txt(sf, e);
}

function numberText(v: number): string {
  if (!Number.isFinite(v)) return '0';
  return v < 0 ? `(${String(v)})` : String(v);
}

function isConditionLiteral(e: ts.Expression): boolean {
  if (e.kind === K.TrueKeyword || e.kind === K.FalseKeyword) return true;
  // minified true/false
  return ts.isPrefixUnaryExpression(e) && e.operator === K.ExclamationToken && ts.isNumericLiteral(e.operand);
}

/** Regex mutations (subset of weapon-regex used by StrykerJS). */
export function regexVariants(literal: string): string[] {
  const last = literal.lastIndexOf('/');
  const pattern = literal.slice(1, last);
  const flags = literal.slice(last + 1);
  const out: string[] = [];
  const add = (p: string) => {
    if (p === pattern || !p) return;
    try {
      new RegExp(p, flags);
    } catch {
      return;
    }
    const lit = `/${p}/${flags}`;
    if (!out.includes(lit)) out.push(lit);
  };
  if (pattern.startsWith('^')) add(pattern.slice(1));
  // scan: escapes, classes, quantifiers, trailing $
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const nx = pattern[i + 1];
      const flip: Record<string, string> = { d: 'D', D: 'd', w: 'W', W: 'w', s: 'S', S: 's' };
      if (nx && flip[nx]) add(pattern.slice(0, i + 1) + flip[nx] + pattern.slice(i + 2));
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '$' && i === pattern.length - 1) add(pattern.slice(0, i));
    let qlen = 0;
    if ((c === '*' || c === '+' || c === '?') && i > 0 && pattern[i - 1] !== '(' && pattern[i - 1] !== '|') qlen = 1;
    if (c === '{') {
      const m = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i));
      if (m && i > 0) qlen = m[0].length;
    }
    if (qlen) {
      if (pattern[i + qlen] === '?') qlen++; // lazy suffix
      add(pattern.slice(0, i) + pattern.slice(i + qlen));
      i += qlen - 1;
    }
  }
  return out;
}

function isPropertyNameish(n: ts.Node): boolean {
  const p = n.parent;
  return !!p && ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p) || ts.isPropertyAccessExpression(p) || ts.isBindingElement(p)) && (p as any).name === n);
}

function isRxOperatorCall(n: ts.Node, names: Set<string>): boolean {
  return ts.isCallExpression(n) && names.has(calleeName(n.expression) || '');
}

function pipeArgSites(sf: ts.SourceFile, n: ts.Node, out: JsEdit[], names: Set<string>): void {
  const m = memberCall(n);
  if (!m || m.name !== 'pipe') return;
  const args = m.call.arguments;
  args.forEach((a, i) => {
    if (isRxOperatorCall(a, names)) out.push(listWithout(sf, args, i));
  });
}

function isValidatorsRef(n: ts.Node): boolean {
  let e = n;
  if (ts.isCallExpression(e)) e = e.expression;
  if (!ts.isPropertyAccessExpression(e)) return false;
  const r = e.expression;
  return (ts.isIdentifier(r) && r.text === 'Validators') || (ts.isPropertyAccessExpression(r) && r.name.text === 'Validators');
}

/* ========================================================== site finders */

const SWAP_METHODS: Record<string, string> = Object.assign(Object.create(null), {
  startsWith: 'endsWith', endsWith: 'startsWith', trimStart: 'trimEnd', trimEnd: 'trimStart', trimLeft: 'trimRight',
  trimRight: 'trimLeft', toUpperCase: 'toLowerCase', toLowerCase: 'toUpperCase', toLocaleUpperCase: 'toLocaleLowerCase',
  toLocaleLowerCase: 'toLocaleUpperCase', some: 'every', every: 'some',
});
const REMOVE_METHODS = new Set(['filter', 'sort', 'reverse', 'slice', 'substring', 'substr', 'trim', 'charAt']);
const UNSUB_OPS = new Set(['take', 'first', 'takeUntil', 'takeWhile']);

export const JS_SITE_FINDERS: Record<string, JsSiteFinder> = {
  'JSM.arith.swap': binaryOpFinder(
    { [K.PlusToken]: '-', [K.MinusToken]: '+', [K.AsteriskToken]: '/', [K.SlashToken]: '*', [K.PercentToken]: '*' },
    (b) => b.operatorToken.kind === K.PlusToken && isStringConcat(b),
  ),

  'JSM.array.empty': finder((n, sf, out) => {
    if (ts.isArrayLiteralExpression(n) && n.elements.length && !isAssignmentPattern(n)) out.push(replaceNode(sf, n, '[]'));
    if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === 'Array' && n.arguments?.length) {
      out.push(replaceNode(sf, n, 'new Array()'));
    }
  }),

  'JSM.arrow.undefined': finder((n, sf, out) => {
    if (ts.isArrowFunction(n) && !ts.isBlock(n.body) && !(ts.isIdentifier(n.body) && n.body.text === 'undefined')) {
      out.push(replaceNode(sf, n.body, 'undefined'));
    }
  }),

  'JSM.assign.invert': binaryOpFinder(
    {
      [K.PlusEqualsToken]: '-=', [K.MinusEqualsToken]: '+=', [K.AsteriskEqualsToken]: '/=', [K.SlashEqualsToken]: '*=',
      [K.PercentEqualsToken]: '*=', [K.LessThanLessThanEqualsToken]: '>>=', [K.GreaterThanGreaterThanEqualsToken]: '<<=',
      [K.AmpersandEqualsToken]: '|=', [K.BarEqualsToken]: '&=', [K.AmpersandAmpersandEqualsToken]: '||=',
      [K.BarBarEqualsToken]: '&&=', [K.QuestionQuestionEqualsToken]: '&&=',
    },
    (b) => b.operatorToken.kind === K.PlusEqualsToken && isStringish(b.right),
  ),

  'JSM.block.empty': finder((n, sf, out) => {
    if (!ts.isBlock(n) || !n.statements.length) return;
    const p = n.parent;
    if (ts.isFunctionDeclaration(p)) return; // JSM.func.remove
    if (ts.isConstructorDeclaration(p) && hasSuperCall(n)) return;
    out.push(replaceNode(sf, n, '{}'));
  }),

  'JSM.bool.swap': finder((n, sf, out) => {
    if (n.kind === K.TrueKeyword) out.push(replaceNode(sf, n, 'false'));
    else if (n.kind === K.FalseKeyword) out.push(replaceNode(sf, n, 'true'));
    else if (ts.isPrefixUnaryExpression(n) && n.operator === K.ExclamationToken) out.push(replaceNode(sf, n, txt(sf, n.operand)));
  }),

  'JSM.cond.true': finder((n, sf, out) => {
    // StrykerJS: loops are only mutated to false (true would hang)
    const c = ts.isIfStatement(n) ? n.expression : ts.isConditionalExpression(n) ? n.condition : null;
    if (c && !isConditionLiteral(c)) out.push(replaceNode(sf, c, 'true'));
  }),

  'JSM.cond.false': finder((n, sf, out) => {
    const c = ts.isIfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n) ? n.expression
      : ts.isConditionalExpression(n) ? n.condition : ts.isForStatement(n) ? n.condition : null;
    if (c && !isConditionLiteral(c)) out.push(replaceNode(sf, c, 'false'));
  }),

  'JSM.eq.boundary': binaryOpFinder({
    [K.LessThanToken]: '<=', [K.LessThanEqualsToken]: '<', [K.GreaterThanToken]: '>=', [K.GreaterThanEqualsToken]: '>',
  }),

  'JSM.eq.negate': binaryOpFinder({
    [K.EqualsEqualsToken]: '!=', [K.ExclamationEqualsToken]: '==', [K.EqualsEqualsEqualsToken]: '!==',
    [K.ExclamationEqualsEqualsToken]: '===', [K.LessThanToken]: '>=', [K.GreaterThanToken]: '<=',
    [K.LessThanEqualsToken]: '>', [K.GreaterThanEqualsToken]: '<',
  }),

  'JSM.eq.strictness': binaryOpFinder({
    [K.EqualsEqualsToken]: '===', [K.EqualsEqualsEqualsToken]: '==', [K.ExclamationEqualsToken]: '!==', [K.ExclamationEqualsEqualsToken]: '!=',
  }),

  'JSM.logical.swap': finder((n, sf, out) => {
    if (!ts.isBinaryExpression(n)) return;
    const k = n.operatorToken.kind;
    const op = k === K.AmpersandAmpersandToken ? '||' : k === K.BarBarToken || k === K.QuestionQuestionToken ? '&&' : null;
    if (!op) return;
    // parenthesised so that `??` never mixes with && / || without parens
    out.push(replaceNode(sf, n, `(${logicalOperand(sf, n.left)} ${op} ${logicalOperand(sf, n.right)})`));
  }),

  'JSM.method.swap': finder((n, sf, out) => {
    const m = memberCall(n);
    if (!m) return;
    const name = (m.call.expression as ts.PropertyAccessExpression).name;
    if (SWAP_METHODS[m.name]) out.push(tokenEdit(sf, name, SWAP_METHODS[m.name]));
    else if ((m.name === 'min' || m.name === 'max') && ts.isIdentifier(m.recv) && m.recv.text === 'Math') {
      out.push(tokenEdit(sf, name, m.name === 'min' ? 'max' : 'min'));
    }
  }),

  'JSM.method.remove': finder((n, sf, out) => {
    const m = memberCall(n);
    if (m && REMOVE_METHODS.has(m.name) && m.recv.kind !== K.SuperKeyword) out.push(replaceNode(sf, n, txt(sf, m.recv)));
  }),

  'JSM.object.empty': finder((n, sf, out) => {
    if (ts.isObjectLiteralExpression(n) && n.properties.length && !isAssignmentPattern(n)) out.push(replaceNode(sf, n, '{}'));
  }),

  'JSM.optChain.remove': finder((n, sf, out) => {
    const q = (n as any).questionDotToken as ts.Node | undefined;
    if (!q || !(ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n))) return;
    if (ts.isNumericLiteral((n as ts.PropertyAccessExpression).expression)) return;
    out.push({ start: q.getStart(sf), end: q.end, text: ts.isPropertyAccessExpression(n) ? '.' : '' });
  }),

  'JSM.regex.mutate': finder((n, sf, out) => {
    if (n.kind !== K.RegularExpressionLiteral) return;
    for (const v of regexVariants(txt(sf, n))) out.push(replaceNode(sf, n, v));
  }),

  'JSM.string.empty': finder((n, sf, out) => {
    if (ts.isStringLiteral(n) && n.text !== '' && !isProtectedString(n)) out.push(replaceNode(sf, n, '""'));
    else if ((ts.isNoSubstitutionTemplateLiteral(n) && n.text !== '') || ts.isTemplateExpression(n)) {
      if (!isProtectedString(n)) out.push(replaceNode(sf, n, '``'));
    }
  }),

  'JSM.string.fill': finder((n, sf, out) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === '' && !isProtectedString(n)) {
      out.push(replaceNode(sf, n, '"Stryker was here!"'));
    }
  }),

  'JSM.unary.swap': finder((n, sf, out) => {
    if (ts.isPrefixUnaryExpression(n) && (n.operator === K.PlusToken || n.operator === K.MinusToken)) {
      const s = n.getStart(sf);
      out.push({ start: s, end: s + 1, text: n.operator === K.PlusToken ? '-' : '+' });
    }
  }),

  'JSM.update.swap': finder((n, sf, out) => {
    if (ts.isPrefixUnaryExpression(n) && (n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken)) {
      const s = n.getStart(sf);
      out.push({ start: s, end: s + 2, text: n.operator === K.PlusPlusToken ? '--' : '++' });
    } else if (ts.isPostfixUnaryExpression(n)) {
      out.push({ start: n.end - 2, end: n.end, text: n.operator === K.PlusPlusToken ? '--' : '++' });
    }
  }),

  'JSM.update.prefix': finder((n, sf, out) => {
    if (ts.isPrefixUnaryExpression(n) && (n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken)) {
      out.push(replaceNode(sf, n, txt(sf, n.operand) + (n.operator === K.PlusPlusToken ? '++' : '--')));
    } else if (ts.isPostfixUnaryExpression(n)) {
      out.push(replaceNode(sf, n, (n.operator === K.PlusPlusToken ? '++' : '--') + txt(sf, n.operand)));
    }
  }),

  'JSM.number.mutate': finder((n, sf, out) => {
    if (!ts.isNumericLiteral(n) || isPropertyNameish(n)) return;
    const v = Number(n.text);
    if (!Number.isFinite(v)) return;
    const after = sf.text[n.end] === '.';
    for (const nv of new Set([v + 1, v - 1, 0])) {
      if (nv === v) continue;
      const t = numberText(nv);
      out.push(replaceNode(sf, n, after && !t.startsWith('(') ? `(${t})` : t));
    }
  }),

  'JSM.negative.invert': finder((n, sf, out) => {
    if (ts.isPrefixUnaryExpression(n) && n.operator === K.MinusToken) out.push(replaceNode(sf, n, txt(sf, n.operand)));
  }),

  'JSM.args.removeOne': finder((n, sf, out) => {
    if (!(ts.isCallExpression(n) || ts.isNewExpression(n)) || !n.arguments?.length) return;
    if (n.expression.kind === K.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) return;
    const args = n.arguments;
    args.forEach((_, i) => out.push(listWithout(sf, args, i)));
  }),

  'JSM.params.removeOne': finder((n, sf, out) => {
    if (!isFunctionLike(n) || !n.parameters.length || ts.isSetAccessorDeclaration(n)) return;
    const ps = n.parameters;
    const parenless = ts.isArrowFunction(n) && !n.getChildren(sf).some((c) => c.kind === K.OpenParenToken);
    ps.forEach((_, i) => {
      const e = listWithout(sf, ps, i);
      out.push(parenless ? { ...e, text: '()' } : e);
    });
  }),

  'JSM.args.swap': finder((n, sf, out) => {
    if (!(ts.isCallExpression(n) || ts.isNewExpression(n)) || !n.arguments || n.arguments.length < 2) return;
    const [a, b] = n.arguments;
    const ta = txt(sf, a);
    const tb = txt(sf, b);
    if (ta !== tb) out.push({ start: a.getStart(sf), end: b.end, text: `${tb}, ${ta}` });
  }),

  'JSM.func.remove': finder((n, sf, out) => {
    if (ts.isFunctionDeclaration(n) && n.body && n.body.statements.length) out.push(replaceNode(sf, n.body, '{}'));
  }),

  'JSM.stmt.remove': finder((n, sf, out) => {
    if (ts.isExpressionStatement(n) && !(ts.isStringLiteral(n.expression) && isPrologue(n))) out.push(replaceNode(sf, n, ';'));
  }),

  'JSM.objProp.remove': finder((n, sf, out) => {
    if (!ts.isObjectLiteralExpression(n) || !n.properties.length || isAssignmentPattern(n)) return;
    n.properties.forEach((_, i) => out.push(listWithout(sf, n.properties, i)));
  }),

  'JSM.switchCase.remove': finder((n, sf, out) => {
    if (ts.isCaseClause(n) || ts.isDefaultClause(n)) out.push(replaceNode(sf, n, ''));
  }),

  'JSM.array.removeElement': finder((n, sf, out) => {
    if (!ts.isArrayLiteralExpression(n) || !n.elements.length || isAssignmentPattern(n)) return;
    if (n.elements.some((e) => e.kind === K.OmittedExpression)) return;
    n.elements.forEach((_, i) => out.push(listWithout(sf, n.elements, i)));
  }),

  'JSM.return.remove': finder((n, sf, out) => {
    if (!ts.isReturnStatement(n)) return;
    // keep the side effects of the returned expression; `{(e);}` is valid in any statement position
    out.push(replaceNode(sf, n, n.expression ? `{(${txt(sf, n.expression)});}` : ';'));
  }),

  'JSM.break.remove': finder((n, sf, out) => {
    if (ts.isBreakStatement(n) || ts.isContinueStatement(n)) out.push(replaceNode(sf, n, ';'));
  }),

  'JSM.else.remove': finder((n, sf, out) => {
    if (!ts.isIfStatement(n) || !n.elseStatement) return;
    const sc = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, sf.text, undefined, n.thenStatement.end);
    if (sc.scan() !== K.ElseKeyword) return;
    out.push({ start: sc.getTokenStart(), end: n.elseStatement.end, text: '' });
  }),

  'JSM.var.remove': finder((n, sf, out) => {
    let list: ts.VariableDeclarationList | undefined;
    if (ts.isVariableStatement(n) && !n.modifiers?.length) list = n.declarationList;
    else if (ts.isForStatement(n) && n.initializer && ts.isVariableDeclarationList(n.initializer)) list = n.initializer;
    if (!list || list.declarations.length !== 1) return;
    if (list.flags & (ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) return;
    const d = list.declarations[0];
    if (!ts.isIdentifier(d.name) || !d.initializer) return;
    out.push({ start: list.getStart(sf), end: list.end, text: `${d.name.text} = ${txt(sf, d.initializer)}` });
  }),

  'JSM.this.remove': finder((n, sf, out) => {
    if (!ts.isPropertyAccessExpression(n) || n.expression.kind !== K.ThisKeyword || !ts.isIdentifier(n.name)) return;
    if (n.questionDotToken || RESERVED.has(n.name.text)) return;
    const p = n.parent;
    if (ts.isDeleteExpression(p)) return; // `delete x` is an early error in strict code
    out.push(replaceNode(sf, n, n.name.text));
  }),

  'JSM.undefined.toNull': finder((n, sf, out) => {
    if (ts.isIdentifier(n) && n.text === 'undefined') {
      const p = n.parent;
      if (isPropertyNameish(n) || ts.isShorthandPropertyAssignment(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) ||
        ts.isFunctionDeclaration(p) || ts.isBindingElement(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) ||
        ts.isPropertyAccessExpression(p) && p.name === n) return;
      if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= K.FirstAssignment && p.operatorToken.kind <= K.LastAssignment) return;
      if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === K.PlusPlusToken || p.operator === K.MinusMinusToken)) return;
      out.push(replaceNode(sf, n, 'null'));
    } else if (ts.isVoidExpression(n) && ts.isNumericLiteral(n.expression) && n.expression.text === '0') {
      out.push(replaceNode(sf, n, 'null')); // minified `undefined`
    }
  }),

  'JSM.falseCheck.mutate': finder((n, sf, out) => {
    if (!ts.isBinaryExpression(n)) return;
    const k = n.operatorToken.kind;
    const neg = k === K.ExclamationEqualsEqualsToken || k === K.ExclamationEqualsToken;
    const pos = k === K.EqualsEqualsEqualsToken || k === K.EqualsEqualsToken;
    if (!neg && !pos) return;
    const other = n.right.kind === K.FalseKeyword ? n.left : n.left.kind === K.FalseKeyword ? n.right : null;
    if (!other) return;
    const o = parenthesize(sf, other);
    out.push(replaceNode(sf, n, neg ? `(${o})` : `(!${o})`));
  }),

  'JSM.catch.remove': finder((n, sf, out) => {
    const m = memberCall(n);
    if (m && m.name === 'catch' && m.recv.kind !== K.SuperKeyword) out.push(replaceNode(sf, n, txt(sf, m.recv)));
    if (ts.isCatchClause(n)) {
      const d = n.variableDeclaration;
      if (d && ts.isIdentifier(d.name)) {
        const body = `{ throw ${d.name.text}; }`;
        if (txt(sf, n.block).replace(/\s+/g, ' ') !== body) out.push(replaceNode(sf, n.block, body));
      } else {
        out.push(replaceNode(sf, n, 'catch (__mlmt_e) { throw __mlmt_e; }'));
      }
    }
    pipeArgSites(sf, n, out, new Set(['catchError']));
  }),

  'JSM.subscribe.remove': finder((n, sf, out) => {
    const m = memberCall(n);
    if (m && m.name === 'subscribe') out.push(replaceNode(sf, n, txt(sf, m.recv)));
  }),

  'JSM.unsubscribe.remove': finder((n, sf, out) => {
    if (ts.isExpressionStatement(n)) {
      const m = memberCall(n.expression);
      if (m && m.name === 'unsubscribe' && !m.call.arguments.length) out.push(replaceNode(sf, n, ';'));
    }
    pipeArgSites(sf, n, out, UNSUB_OPS);
  }),

  'JSM.validators.remove': finder((n, sf, out) => {
    if (ts.isArrayLiteralExpression(n) && !isAssignmentPattern(n) && !n.elements.some((e) => e.kind === K.OmittedExpression)) {
      n.elements.forEach((e, i) => {
        if (isValidatorsRef(e)) out.push(listWithout(sf, n.elements, i));
      });
    }
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments) {
      for (const a of n.arguments) if (isValidatorsRef(a)) out.push(replaceNode(sf, a, 'null'));
    }
  }),
};

/* ============================================================ core rewrite */

const WORD = /[\w$\u0080-￿\\]/;
function merges(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (WORD.test(a) && WORD.test(b)) return true;
  if ('+-'.includes(a) && '+-'.includes(b)) return true;
  if (a === '/' && (b === '/' || b === '*')) return true;
  if (a === '.' && /\d/.test(b)) return true;
  return false;
}

/** Apply an edit, inserting a space where the replacement would fuse with its neighbours. */
export function applyEdit(code: string, e: JsEdit): string {
  const prev = code[e.start - 1];
  const next = code[e.end];
  let t = e.text;
  if (!t) {
    if (merges(prev, next)) t = ' ';
  } else {
    if (merges(prev, t[0])) t = ' ' + t;
    if (merges(t[t.length - 1], next)) t += ' ';
  }
  return code.slice(0, e.start) + t + code.slice(e.end);
}

export function parseJs(code: string, fileName = 'script.js'): ts.SourceFile | null {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return ((sf as any).parseDiagnostics || []).length ? null : sf;
}

/** Syntax check of mutated code: V8 for classic scripts, the TS parser otherwise (modules). */
export function isValidJs(code: string, original?: { v8: boolean }): boolean {
  if (original?.v8 !== false) {
    try {
      new vm.Script(code);
      return true;
    } catch (e) {
      if (original?.v8) return false;
    }
  }
  return parseJs(code) !== null;
}

function v8Parses(code: string): boolean {
  try {
    new vm.Script(code);
    return true;
  } catch {
    return false;
  }
}

/** All sites of an operator in a JS source (source order). */
export function findJsSites(code: string | ts.SourceFile, opId: string, maxNodes = DEFAULT_MAX_NODES): JsEdit[] {
  const f = JS_SITE_FINDERS[opId];
  if (!f) throw new Error(`unknown JS source operator ${opId}`);
  const sf = typeof code === 'string' ? parseJs(code) : code;
  if (!sf) return [];
  const prev = budget;
  budget = maxNodes;
  try {
    return f(sf, ts);
  } finally {
    budget = prev;
  }
}

const clip = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/**
 * Mutate a JS source with one operator. Returns null (not applicable) when
 * the source does not parse, has no site for `variant`, or the mutant would
 * not be syntactically valid.
 */
export function mutateJs(code: string, opId: string, variant: number, key: string, opts: JsMutateOptions = {}): JsMutationResult | null {
  const sf = opts.sourceFile ?? parseJs(code);
  if (!sf) return null;
  const sites = findJsSites(sf, opId, opts.maxNodes ?? DEFAULT_MAX_NODES);
  // variants beyond the number of sites would duplicate an earlier variant
  if (!sites.length || variant >= sites.length) return null;
  const idx = (hash32(key + opId) + variant * 7919) % sites.length;
  const edit = sites[idx];
  const out = applyEdit(code, edit);
  if (out === code) return null;
  if (opts.verify !== false && !isValidJs(out, { v8: v8Parses(code) })) return null;
  const lc = sf.getLineAndCharacterOfPosition(edit.start);
  const detail = `${opId} at ${lc.line + 1}:${lc.character + 1}: ${clip(code.slice(edit.start, edit.end)) || '∅'} → ${clip(edit.text) || '∅'}`;
  return { code: out, edit, detail, siteCount: sites.length, siteIndex: idx };
}

/* ============================================================== runtime */

function strippedHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'etag' || lk === 'digest') continue;
    out[k] = v;
  }
  return out;
}

function looksLikeJs(url: string, contentType: string): boolean {
  if (/javascript|ecmascript|\bjsx?\b/i.test(contentType)) return true;
  if (/html|css|json|image|font|xml/i.test(contentType)) return false;
  return /\.(m|c)?js(\?|#|$)/i.test(url);
}

/**
 * Browser init script: drop Subresource Integrity on the mutated script
 * (otherwise the rewritten body is blocked). Parser-inserted elements are
 * handled with a MutationObserver from document start (as SFM.script.fail);
 * script-created elements through the `integrity`/`src` setters, before
 * insertion triggers the fetch.
 */
export function integrityStripper(url: string): void {
  const w = window as any;
  const key = '__mlmtSriStrip';
  if (w[key] && w[key][url]) return;
  (w[key] ||= {})[url] = true;
  const hits = (n: any) => {
    try {
      return (n.tagName === 'SCRIPT' && n.src === url) || (n.tagName === 'LINK' && n.href === url);
    } catch {
      return false;
    }
  };
  const fix = (n: any) => {
    if (n && n.nodeType === 1 && n.hasAttribute('integrity') && hits(n)) n.removeAttribute('integrity');
  };
  const scan = (root: any) => {
    fix(root);
    if (root.querySelectorAll) root.querySelectorAll('script[integrity],link[integrity]').forEach(fix);
  };
  try {
    for (const proto of [HTMLScriptElement.prototype, HTMLLinkElement.prototype] as any[]) {
      const attr = proto === HTMLScriptElement.prototype ? 'src' : 'href';
      for (const prop of [attr, 'integrity']) {
        const d = Object.getOwnPropertyDescriptor(proto, prop);
        if (!d || !d.set) continue;
        Object.defineProperty(proto, prop, {
          ...d,
          set(v: any) {
            d.set!.call(this, v);
            fix(this);
          },
        });
      }
    }
    const sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      sa.call(this, name, value);
      if (/^(src|href|integrity)$/i.test(name)) fix(this);
    };
  } catch {
    /* ignore */
  }
  new MutationObserver((ms) => {
    for (const m of ms) m.addedNodes.forEach(scan);
  }).observe(document, { childList: true, subtree: true });
  if (document.documentElement) scan(document.documentElement);
}

function inScope(ctx: DomNodeContext, req: Request): boolean {
  if (!ctx.pageKey || ctx.pageKey === '*') return true;
  let url = '';
  try {
    const f = req.frame();
    url = f.page()?.url() || f.url();
  } catch {
    return true; // worker / unknown frame
  }
  if (!/^https?:/.test(url)) return true;
  return ctx.pageKeyOf(url) === ctx.pageKey;
}

/** The shared nodeApply of all JSM.* operators. */
export function jsNodeApply(opId: string): (ctx: DomNodeContext) => Promise<void> {
  return async (ctx) => {
    const url = ctx.resourceUrl;
    if (!url) return;
    const variant = Math.max(0, Math.floor(Number(ctx.params.variant ?? 0)) || 0);
    const maxNodes = Number(ctx.params.maxNodes ?? DEFAULT_MAX_NODES);
    const context: BrowserContext = ctx.context;
    let memo: { body: string; result: JsMutationResult | null } | null = null;
    await context.addInitScript({ content: `(${integrityStripper.toString()})(${JSON.stringify(url)});` });
    await context.route(
      (u) => u.href === url,
      async (route: Route, req: Request) => {
        try {
          if (!inScope(ctx, req)) return await route.fallback();
          const res = await route.fetch();
          const status = res.status();
          const headers = res.headers();
          if (status < 200 || status >= 300 || !looksLikeJs(url, headers['content-type'] || '')) return await route.fulfill({ response: res });
          const body = (await res.body()).toString('utf8');
          if (!memo || memo.body !== body) {
            memo = { body, result: mutateJs(body, opId, variant, url, { maxNodes, verify: ctx.params.verify !== false }) };
          }
          const r = memo.result;
          if (!r) return await route.fulfill({ response: res });
          await route.fulfill({ status, headers: strippedHeaders(headers), body: r.code });
          ctx.applied(r.detail);
        } catch {
          try {
            await route.fallback();
          } catch {
            /* route already handled or context closing */
          }
        }
      },
    );
  };
}

/* ============================================================ operators */

type Meta = { id: string; intent: string; refs: string[]; aliases: string[] };

const S = 'Stryker';
const M = 'RodriguezBaquero18';
const MU = 'Mirshokraie15';
const A = 'Augustin25';

const META: Meta[] = [
  { id: 'JSM.arith.swap', intent: 'Wrong arithmetic operator in application code (+↔−, *↔/, %→*).', refs: [S, M, MU], aliases: ['Stryker:ArithmeticOperator', 'Mutode:math', 'Mutandis:Var-4', 'Mutandis:Loop-5'] },
  { id: 'JSM.array.empty', intent: 'An array literal (or new Array(…)) is created empty.', refs: [S], aliases: ['Stryker:ArrayDeclaration'] },
  { id: 'JSM.arrow.undefined', intent: 'An expression-bodied arrow function returns undefined.', refs: [S], aliases: ['Stryker:ArrowFunction'] },
  { id: 'JSM.assign.invert', intent: 'Wrong compound assignment operator (+=↔-=, *=↔/=, &&=↔||=, ??=→&&=).', refs: [S], aliases: ['Stryker:AssignmentOperator'] },
  { id: 'JSM.block.empty', intent: 'A block (non-declaration function body or statement block) does nothing.', refs: [S], aliases: ['Stryker:BlockStatement'] },
  { id: 'JSM.bool.swap', intent: 'Inverted boolean literal or dropped negation.', refs: [S, M, MU], aliases: ['Stryker:BooleanLiteral', 'Mutode:booleanLiterals', 'Mutandis:Cond-7', 'Mutandis:Ret-2'] },
  { id: 'JSM.cond.true', intent: 'An if/ternary condition is always true.', refs: [S, M], aliases: ['Stryker:ConditionalExpression', 'Mutode:removeConditionals'] },
  { id: 'JSM.cond.false', intent: 'An if/loop/ternary condition is always false.', refs: [S, M], aliases: ['Stryker:ConditionalExpression', 'Mutode:removeConditionals'] },
  { id: 'JSM.eq.boundary', intent: 'Off-by-one relational boundary (<↔<=, >↔>=).', refs: [S, M], aliases: ['Stryker:EqualityOperator', 'Mutode:conditionalsBoundary'] },
  { id: 'JSM.eq.negate', intent: 'Negated comparison (==↔!=, ===↔!==, <→>=, >→<=).', refs: [S, M, MU], aliases: ['Stryker:EqualityOperator', 'Mutode:negateConditionals', 'Mutandis:Loop-3', 'Mutandis:Cond-3'] },
  { id: 'JSM.eq.strictness', intent: 'Loose/strict equality confusion (==↔===, !=↔!==).', refs: [A], aliases: ['Augustin25:Comparison'] },
  { id: 'JSM.logical.swap', intent: 'Wrong logical connective (&&↔||, ??→&&).', refs: [S, MU], aliases: ['Stryker:LogicalOperator', 'Mutandis:Loop-4', 'Mutandis:Cond-4'] },
  { id: 'JSM.method.swap', intent: 'Call to the dual library method (startsWith↔endsWith, toUpperCase↔toLowerCase, some↔every, Math.min↔max, …).', refs: [S], aliases: ['Stryker:MethodExpression'] },
  { id: 'JSM.method.remove', intent: 'A filtering/ordering/slicing method call is dropped (x.filter(…) → x).', refs: [S], aliases: ['Stryker:MethodExpression'] },
  { id: 'JSM.object.empty', intent: 'An object literal is created empty.', refs: [S], aliases: ['Stryker:ObjectLiteral'] },
  { id: 'JSM.optChain.remove', intent: 'Optional chaining dropped (a?.b → a.b): missing null guard.', refs: [S], aliases: ['Stryker:OptionalChaining'] },
  { id: 'JSM.regex.mutate', intent: 'Weakened/altered regular expression (anchor, quantifier or class removed/negated).', refs: [S], aliases: ['Stryker:Regex'] },
  { id: 'JSM.string.empty', intent: 'A non-empty string literal becomes empty.', refs: [S, M], aliases: ['Stryker:StringLiteral', 'Mutode:stringLiterals'] },
  { id: 'JSM.string.fill', intent: 'An empty string literal becomes non-empty.', refs: [S], aliases: ['Stryker:StringLiteral'] },
  { id: 'JSM.unary.swap', intent: 'Unary plus/minus swapped.', refs: [S], aliases: ['Stryker:UnaryOperator'] },
  { id: 'JSM.update.swap', intent: 'Increment instead of decrement and vice versa.', refs: [S, M], aliases: ['Stryker:UpdateOperator', 'Mutode:increments'] },
  { id: 'JSM.update.prefix', intent: 'Prefix/postfix update confusion (x++↔++x).', refs: [MU], aliases: ['Mutandis:Loop-6'] },
  { id: 'JSM.number.mutate', intent: 'Numeric literal off by one or zeroed.', refs: [M, MU], aliases: ['Mutode:numericLiterals', 'Mutandis:Var-1', 'Mutandis:Loop-1'] },
  { id: 'JSM.negative.invert', intent: 'Negation dropped (-a → a).', refs: [M], aliases: ['Mutode:invertNegatives'] },
  { id: 'JSM.args.removeOne', intent: 'A call argument is omitted.', refs: [M, MU], aliases: ['Mutode:removeFuncCallArgs', 'Mutandis:Par-2'] },
  { id: 'JSM.params.removeOne', intent: 'A declared function parameter is omitted.', refs: [M], aliases: ['Mutode:removeFuncParams'] },
  { id: 'JSM.args.swap', intent: 'The first two call arguments are swapped.', refs: [MU], aliases: ['Mutandis:Par-1'] },
  { id: 'JSM.func.remove', intent: 'A function declaration does nothing.', refs: [M], aliases: ['Mutode:removeFunctions'] },
  { id: 'JSM.stmt.remove', intent: 'An expression statement is missing.', refs: [M, 'Nishiura13'], aliases: ['Mutode:removeLines', 'RevAjaxMutator:StatementDelete'] },
  { id: 'JSM.objProp.remove', intent: 'An object-literal property is missing.', refs: [M], aliases: ['Mutode:removeObjProps'] },
  { id: 'JSM.switchCase.remove', intent: 'A switch case clause is missing.', refs: [M], aliases: ['Mutode:removeSwitchCases'] },
  { id: 'JSM.array.removeElement', intent: 'An array literal element is missing.', refs: [M], aliases: ['Mutode:removeArrayElements'] },
  { id: 'JSM.return.remove', intent: 'A return statement is missing (its expression is still evaluated).', refs: [MU], aliases: ['Mutandis:Ret-1'] },
  { id: 'JSM.break.remove', intent: 'A break/continue is missing.', refs: [MU], aliases: ['Mutandis:Loop-7', 'Mutandis:Cond-6'] },
  { id: 'JSM.else.remove', intent: 'An else branch is missing.', refs: [MU], aliases: ['Mutandis:Cond-5'] },
  { id: 'JSM.var.remove', intent: 'A missing var/let/const leaks the variable to the global scope.', refs: [MU], aliases: ['Mutandis:Var-2'] },
  { id: 'JSM.this.remove', intent: 'A missing `this.` resolves the name in the enclosing/global scope.', refs: [MU], aliases: ['Mutandis:this'] },
  { id: 'JSM.undefined.toNull', intent: 'undefined (or void 0) replaced by null.', refs: [MU], aliases: ['Mutandis:undefined-null'] },
  { id: 'JSM.falseCheck.mutate', intent: 'A check against false is dropped or inverted (f() !== false → f(), f() === false → !f()).', refs: [MU], aliases: ['Mutandis:false-check'] },
  { id: 'JSM.catch.remove', intent: 'Error handling is missing (.catch dropped, catch block rethrows, catchError removed from pipe).', refs: [A], aliases: ['Augustin25:ErrorHandling'] },
  { id: 'JSM.subscribe.remove', intent: 'An observable is never subscribed (x.subscribe(…) → x).', refs: [A], aliases: ['Augustin25:SubscribeCall'] },
  { id: 'JSM.unsubscribe.remove', intent: 'A subscription is never released (unsubscribe() or take/first/takeUntil/takeWhile removed).', refs: [A], aliases: ['Augustin25:UnsubscribeCall'] },
  { id: 'JSM.validators.remove', intent: 'An Angular form validator is missing.', refs: [A], aliases: ['Augustin25:InputValidation'] },
];

export const JS_SOURCE_OPERATORS: OperatorDef[] = META.map((m) =>
  domOp({
    ...m,
    scope: 'page',
    category: 'JavaScript Source Mutations',
    perResource: 'script',
    variants: 3,
    // maxNodes: node budget of the site enumeration; verify: syntax re-check of the mutant
    defaults: { maxNodes: DEFAULT_MAX_NODES, verify: true },
    nodeApply: jsNodeApply(m.id),
  }),
);
