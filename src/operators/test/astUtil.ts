import * as ts from 'typescript';

/**
 * AST helpers shared by the test-script operators (thesis operators in
 * astMutator.ts and the literature operators in ../lit/test.ts).
 * No dependency on the registry (the literature modules load before it).
 */

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export interface Site {
  edits: TextEdit[];
  line: number;
  snippet: string;
  description: string;
}

export const WAIT_METHODS = new Set([
  'waitForSelector', 'waitForTimeout', 'waitForLoadState', 'waitForURL', 'waitForResponse', 'waitForRequest',
  'waitForNavigation', 'waitForFunction', 'waitForEvent', 'waitFor',
]);

export const ACTION_METHODS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'pressSequentially', 'check', 'uncheck', 'selectOption', 'hover',
  'tap', 'setInputFiles', 'setChecked', 'dragTo', 'clear',
]);

export const SELECTOR_METHODS = new Set([
  'locator', 'click', 'dblclick', 'fill', 'type', 'press', 'check', 'uncheck', 'hover', 'tap', 'selectOption',
  'waitForSelector', '$', '$$', '$eval', '$$eval', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled', 'isChecked',
  'textContent', 'innerText', 'innerHTML', 'inputValue', 'getAttribute', 'focus', 'setInputFiles', 'dispatchEvent',
]);

export const GET_BY = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTitle', 'getByAltText', 'getByTestId']);

export const NO_ARG_MATCHERS = new Set([
  'toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeUndefined', 'toBeNull', 'toBeNaN', 'toBeVisible', 'toBeHidden',
  'toBeEnabled', 'toBeDisabled', 'toBeChecked', 'toBeEditable', 'toBeEmpty', 'toBeFocused', 'toBeAttached',
]);

/* --------------------------------------------------------------- helpers */

export function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

export function snippetOf(sf: ts.SourceFile, node: ts.Node): string {
  return node.getText(sf).replace(/\s+/g, ' ').slice(0, 140);
}

export function visit(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node);
  node.forEachChild((c) => visit(c, cb));
}

export function methodName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isIdentifier(e)) return e.text;
  return null;
}

/** Unwrap `await x` and parentheses. */
export function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** Is `e` an `expect(...)`, `expect.soft(...)` or `expect.poll(...)` call? */
export function isExpectCall(e: ts.Expression): e is ts.CallExpression {
  if (!ts.isCallExpression(e)) return false;
  const c = e.expression;
  if (ts.isIdentifier(c)) return c.text === 'expect';
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)) {
    return c.expression.text === 'expect' && ['soft', 'poll'].includes(c.name.text);
  }
  return false;
}

export interface MatcherCall {
  call: ts.CallExpression;
  access: ts.PropertyAccessExpression;
  expectCall: ts.CallExpression;
  notAccess: ts.PropertyAccessExpression | null;
  name: string;
}

/** `expect(x)[.not].matcher(args)` */
export function asMatcherCall(n: ts.Node): MatcherCall | null {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return null;
  const access = n.expression;
  const obj = access.expression;
  if (isExpectCall(obj)) return { call: n, access, expectCall: obj, notAccess: null, name: access.name.text };
  if (ts.isPropertyAccessExpression(obj) && obj.name.text === 'not' && isExpectCall(obj.expression)) {
    return { call: n, access, expectCall: obj.expression, notAccess: obj, name: access.name.text };
  }
  return null;
}

export function rootIdentifier(e: ts.Expression): string | null {
  let cur: ts.Expression = e;
  while (true) {
    if (ts.isCallExpression(cur)) cur = cur.expression;
    else if (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
    else if (ts.isElementAccessExpression(cur)) cur = cur.expression;
    else if (ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) cur = cur.expression;
    else break;
  }
  if (ts.isIdentifier(cur)) return cur.text;
  if (cur.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  return null;
}

export function indentAt(sf: ts.SourceFile, pos: number): string {
  const text = sf.text;
  let i = pos;
  while (i > 0 && text[i - 1] !== '\n') i--;
  const m = text.slice(i, pos).match(/^\s*/);
  return m ? m[0] : '';
}

export function isStringLike(n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
}

export function replaceLiteral(sf: ts.SourceFile, lit: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, value: string): TextEdit {
  const q = lit.getText(sf)[0];
  let body: string;
  if (q === '`') body = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  else {
    body = JSON.stringify(value).slice(1, -1); // escapes backslashes, newlines and control characters
    if (q === "'") body = body.replace(/\\"/g, '"').replace(/'/g, "\\'");
  }
  return { start: lit.getStart(sf), end: lit.end, text: q + body + q };
}

export function site(sf: ts.SourceFile, node: ts.Node, edits: TextEdit[], description: string): Site {
  return { edits, line: lineOf(sf, node.getStart(sf)), snippet: snippetOf(sf, node), description };
}

