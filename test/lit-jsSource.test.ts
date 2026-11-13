import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import * as vm from 'vm';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import { chromium, Browser } from '@playwright/test';
import {
  JS_SITE_FINDERS, JS_SOURCE_OPERATORS, applyEdit, findJsSites, mutateJs, parseJs, regexVariants,
} from '../src/operators/lit/jsSource';
import { applyMutant } from '../src/runtime/instrument';
import { registry } from '../src/operators/registry';
import { pageKeyOf } from '../src/util/pageKey';
import type { DomOperatorDef } from '../src/operators/registry';
import type { MutantDescriptor } from '../src/types';

/* ================================================================ unit */

/** All mutants of an operator on a snippet (one per site, source order). */
function mutants(code: string, op: string): string[] {
  return findJsSites(code, op).map((e) => applyEdit(code, e));
}

function assertValid(code: string, module = false) {
  if (module) assert.ok(parseJs(code), `does not parse: ${code}`);
  else assert.doesNotThrow(() => new vm.Script(code), `invalid JS: ${code}`);
}

/** op → [snippet, expected mutants (subset, exact text)] */
const UNIT: Record<string, [string, string[]]> = {
  'JSM.arith.swap': ['x = a + b * c % d - e / f;', ['x = a - b * c % d - e / f;', 'x = a + b / c % d - e / f;', 'x = a + b * c * d - e / f;', 'x = a + b * c % d + e / f;', 'x = a + b * c % d - e * f;']],
  'JSM.array.empty': ['const xs = [1, 2]; const ys = new Array(3);', ['const xs = []; const ys = new Array(3);', 'const xs = [1, 2]; const ys = new Array();']],
  'JSM.arrow.undefined': ['const f = (a) => a * 2;', ['const f = (a) => undefined;']],
  'JSM.assign.invert': ['a += 1; b *= 2; c &&= d; e ??= f;', ['a -= 1; b *= 2; c &&= d; e ??= f;', 'a += 1; b /= 2; c &&= d; e ??= f;', 'a += 1; b *= 2; c ||= d; e ??= f;', 'a += 1; b *= 2; c &&= d; e &&= f;']],
  'JSM.block.empty': ['const f = function () { go(); }; if (x) { y(); }', ['const f = function () {}; if (x) { y(); }', 'const f = function () { go(); }; if (x) {}']],
  'JSM.bool.swap': ['a = true; b = false; c = !d;', ['a = false; b = false; c = !d;', 'a = true; b = true; c = !d;', 'a = true; b = false; c = d;']],
  'JSM.cond.true': ['if (a > 1) go(); x = b ? 1 : 2; while (c) d();', ['if (true) go(); x = b ? 1 : 2; while (c) d();', 'if (a > 1) go(); x = true ? 1 : 2; while (c) d();']],
  'JSM.cond.false': ['if (a > 1) go(); while (c) d(); for (;i < 3;) i++;', ['if (false) go(); while (c) d(); for (;i < 3;) i++;', 'if (a > 1) go(); while (false) d(); for (;i < 3;) i++;', 'if (a > 1) go(); while (c) d(); for (;false;) i++;']],
  'JSM.eq.boundary': ['a < b; c >= d;', ['a <= b; c >= d;', 'a < b; c > d;']],
  'JSM.eq.negate': ['a === b; c < d; e != f;', ['a !== b; c < d; e != f;', 'a === b; c >= d; e != f;', 'a === b; c < d; e == f;']],
  'JSM.eq.strictness': ['a == b; c !== d;', ['a === b; c !== d;', 'a == b; c != d;']],
  'JSM.logical.swap': ['x = a && b; y = c ?? d ?? e;', ['x = (a || b); y = c ?? d ?? e;', 'x = a && b; y = ((c ?? d) && e);', 'x = a && b; y = (c && d) ?? e;']],
  'JSM.method.swap': ['s.startsWith("a"); s.toUpperCase(); xs.some(f); Math.min(1, 2);', ['s.endsWith("a"); s.toUpperCase(); xs.some(f); Math.min(1, 2);', 's.startsWith("a"); s.toLowerCase(); xs.some(f); Math.min(1, 2);', 's.startsWith("a"); s.toUpperCase(); xs.every(f); Math.min(1, 2);', 's.startsWith("a"); s.toUpperCase(); xs.some(f); Math.max(1, 2);']],
  'JSM.method.remove': ['y = xs.filter((x) => x > 1).length; t = s.trim();', ['y = xs.length; t = s.trim();', 'y = xs.filter((x) => x > 1).length; t = s;']],
  'JSM.object.empty': ['const o = { a: 1 }; ({ b } = o);', ['const o = {}; ({ b } = o);']],
  'JSM.optChain.remove': ['a?.b; c?.[0]; f?.();', ['a.b; c?.[0]; f?.();', 'a?.b; c[0]; f?.();', 'a?.b; c?.[0]; f();']],
  'JSM.regex.mutate': ['const r = /^\\d+$/;', ['const r = /\\d+$/;', 'const r = /^\\D+$/;', 'const r = /^\\d$/;', 'const r = /^\\d+/;']],
  'JSM.string.empty': ['"use strict"; import("m"); const s = "hi"; const o = { "k": `t` };', ['"use strict"; import("m"); const s = ""; const o = { "k": `t` };', '"use strict"; import("m"); const s = "hi"; const o = { "k": `` };']],
  'JSM.string.fill': ['const s = ""; const t = ``;', ['const s = "Stryker was here!"; const t = ``;', 'const s = ""; const t = "Stryker was here!";']],
  'JSM.unary.swap': ['a = -b; c = +d; e = f+-g;', ['a = +b; c = +d; e = f+-g;', 'a = -b; c = -d; e = f+-g;', 'a = -b; c = +d; e = f+ +g;']],
  'JSM.update.swap': ['i++; --j;', ['i--; --j;', 'i++; ++j;']],
  'JSM.update.prefix': ['i++; --j;', ['++i; --j;', 'i++; j--;']],
  'JSM.number.mutate': ['x = 5; y = 1..toFixed(); z = { 3: a };', ['x = 6; y = 1..toFixed(); z = { 3: a };', 'x = 4; y = 1..toFixed(); z = { 3: a };', 'x = 0; y = 1..toFixed(); z = { 3: a };', 'x = 5; y = (2).toFixed(); z = { 3: a };', 'x = 5; y = (0).toFixed(); z = { 3: a };']],
  'JSM.negative.invert': ['a = -b; c = d- -e;', ['a = b; c = d- -e;', 'a = -b; c = d- e;']],
  'JSM.args.removeOne': ['f(a, b); require("x");', ['f(b); require("x");', 'f(a); require("x");']],
  'JSM.params.removeOne': ['function f(a, b) {} const g = x => x;', ['function f(b) {} const g = x => x;', 'function f(a) {} const g = x => x;', 'function f(a, b) {} const g = () => x;']],
  'JSM.args.swap': ['f(a, b, c); g(x, x);', ['f(b, a, c); g(x, x);']],
  'JSM.func.remove': ['function f() { return 1; } const g = function () { return 2; };', ['function f() {} const g = function () { return 2; };']],
  'JSM.stmt.remove': ['"use strict"; a(); if (x) b(); else c();', ['"use strict"; ; if (x) b(); else c();', '"use strict"; a(); if (x) ; else c();', '"use strict"; a(); if (x) b(); else ;']],
  'JSM.objProp.remove': ['o = { a: 1, b: 2 };', ['o = { b: 2 };', 'o = { a: 1 };']],
  'JSM.switchCase.remove': ['switch (k) { case 1: a(); break; default: b(); }', ['switch (k) {  default: b(); }', 'switch (k) { case 1: a(); break;  }']],
  'JSM.array.removeElement': ['xs = [1, 2, 3];', ['xs = [2, 3];', 'xs = [1, 3];', 'xs = [1, 2];']],
  'JSM.return.remove': ['function f() { if (a) return g(); else return; }', ['function f() { if (a) {(g());} else return; }', 'function f() { if (a) return g(); else ; }']],
  'JSM.break.remove': ['for (;;) { if (a) break; if (b) continue; }', ['for (;;) { if (a) ; if (b) continue; }', 'for (;;) { if (a) break; if (b) ; }']],
  'JSM.else.remove': ['if (a) b(); else c();\nif (d) { e(); } /* x */ else { f(); }', ['if (a) b(); \nif (d) { e(); } /* x */ else { f(); }', 'if (a) b(); else c();\nif (d) { e(); } /* x */ ']],
  'JSM.var.remove': ['let a = 1; const b = 2, c = 3; for (var i = 0; i < 2; i++) {} export const z = 1;', ['a = 1; const b = 2, c = 3; for (var i = 0; i < 2; i++) {} export const z = 1;', 'let a = 1; const b = 2, c = 3; for (i = 0; i < 2; i++) {} export const z = 1;']],
  'JSM.this.remove': ['class A { m() { return this.x + this.default; } n() { delete this.y; } }', ['class A { m() { return x + this.default; } n() { delete this.y; } }']],
  'JSM.undefined.toNull': ['x = undefined; y = void 0; o.undefined = 1;', ['x = null; y = void 0; o.undefined = 1;', 'x = undefined; y = null; o.undefined = 1;']],
  'JSM.falseCheck.mutate': ['if (f() !== false) a(); if (g() === false) b();', ['if ((f())) a(); if (g() === false) b();', 'if (f() !== false) a(); if ((!g())) b();']],
  'JSM.catch.remove': ['p.then(a).catch(h); try { x(); } catch (e) { log(e); } try { y(); } catch { z(); } s.pipe(map(f), catchError(h));', [
    'p.then(a); try { x(); } catch (e) { log(e); } try { y(); } catch { z(); } s.pipe(map(f), catchError(h));',
    'p.then(a).catch(h); try { x(); } catch (e) { throw e; } try { y(); } catch { z(); } s.pipe(map(f), catchError(h));',
    'p.then(a).catch(h); try { x(); } catch (e) { log(e); } try { y(); } catch (__mlmt_e) { throw __mlmt_e; } s.pipe(map(f), catchError(h));',
    'p.then(a).catch(h); try { x(); } catch (e) { log(e); } try { y(); } catch { z(); } s.pipe(map(f));',
  ]],
  'JSM.subscribe.remove': ['this.svc.load().subscribe((v) => (this.v = v));', ['this.svc.load();']],
  'JSM.unsubscribe.remove': ['this.sub.unsubscribe(); s.pipe(take(1), map(f)); s.pipe((0, o.takeUntil)(d));', ['; s.pipe(take(1), map(f)); s.pipe((0, o.takeUntil)(d));', 'this.sub.unsubscribe(); s.pipe(map(f)); s.pipe((0, o.takeUntil)(d));', 'this.sub.unsubscribe(); s.pipe(take(1), map(f)); s.pipe();']],
  'JSM.validators.remove': ['c = new FormControl("", [Validators.required, Validators.minLength(3)]); d = new FormControl("", f.Validators.email);', [
    'c = new FormControl("", [Validators.minLength(3)]); d = new FormControl("", f.Validators.email);',
    'c = new FormControl("", [Validators.required]); d = new FormControl("", f.Validators.email);',
    'c = new FormControl("", [Validators.required, Validators.minLength(3)]); d = new FormControl("", null);',
  ]],
};

/** Snippets on which an operator must find no site. */
const NONE: Record<string, string> = {
  'JSM.arith.swap': 'x = "a" + b;',
  'JSM.array.empty': '[a, b] = [];',
  'JSM.arrow.undefined': 'f = () => { return 1; }; g = () => undefined;',
  'JSM.block.empty': 'function f() { g(); } class B extends A { constructor() { super(); } }',
  'JSM.cond.true': 'while (x) y(); if (true) z();',
  'JSM.string.empty': 'import "a"; require("b"); o = { "k": 1 };',
  'JSM.var.remove': 'let a, b = 1; const { c } = d; for (const k of ks) {}',
  'JSM.this.remove': 'delete this.x; this.class = 1;',
  'JSM.params.removeOne': 'o = { set v(x) { this._v = x; } };',
  'JSM.method.swap': 'Foo.min(1); s.constructor();',
};

describe('JSM site finders (unit)', () => {
  test('every operator has a finder, a unit case and is registered', () => {
    const ids = JS_SOURCE_OPERATORS.map((o) => o.id);
    assert.equal(ids.length, 43);
    assert.deepEqual(new Set(ids), new Set(Object.keys(JS_SITE_FINDERS)));
    for (const id of ids) {
      assert.ok(UNIT[id], `unit case for ${id}`);
      const def = registry.get(id) as DomOperatorDef;
      assert.equal(def.layer, 'dom');
      assert.equal(def.scope, 'page');
      assert.equal(def.perResource, 'script');
      assert.equal(def.variants, 3);
      assert.equal(typeof def.nodeApply, 'function');
    }
  });

  for (const [op, [code, expected]] of Object.entries(UNIT)) {
    test(op, () => {
      const isModule = /\bexport\b/.test(code);
      assertValid(code, isModule);
      const ms = mutants(code, op);
      for (const e of expected) assert.ok(ms.includes(e), `${op}: expected mutant\n  ${e}\nnot in\n  ${ms.join('\n  ')}`);
      for (const m of ms) {
        assert.notEqual(m, code);
        assertValid(m, isModule);
      }
    });
  }

  for (const [op, code] of Object.entries(NONE)) {
    test(`${op}: no site on non-targets`, () => assert.deepEqual(mutants(code, op), []));
  }

  test('boundary glue keeps tokens apart', () => {
    assert.deepEqual(mutants('return!0', 'JSM.bool.swap').length, 1);
    const m = mutants('function f(){return!0}', 'JSM.bool.swap')[0];
    assert.equal(m, 'function f(){return 0}');
    assert.equal(mutants('x=a+-b', 'JSM.negative.invert')[0], 'x=a+b');
    assert.equal(mutants('x=a- -b', 'JSM.arith.swap')[0], 'x=a+ -b');
    assert.equal(mutants('x=a+ +b', 'JSM.arith.swap')[0], 'x=a- +b');
    assert.equal(mutants('x=0**2', 'JSM.number.mutate')[1], 'x=(-1)**2');
  });

  test('regex variants are valid regexes', () => {
    const vs = regexVariants('/^(?:ab)+[a-z?]{2,3}?\\w$/gi');
    assert.ok(vs.includes('/(?:ab)+[a-z?]{2,3}?\\w$/gi'));
    assert.ok(vs.includes('/^(?:ab)[a-z?]{2,3}?\\w$/gi'));
    assert.ok(vs.includes('/^(?:ab)+[a-z?]\\w$/gi'));
    assert.ok(vs.includes('/^(?:ab)+[a-z?]{2,3}?\\W$/gi'));
    for (const v of vs) assert.doesNotThrow(() => vm.runInNewContext(v));
  });

  test('mutateJs: deterministic pick, variants, detail, skip cases', () => {
    const code = 'a = 1 + 2; b = 3 - 4; c = 5 * 6; d = 7 / 8;';
    const r0 = mutateJs(code, 'JSM.arith.swap', 0, 'http://x/a.js')!;
    const r0b = mutateJs(code, 'JSM.arith.swap', 0, 'http://x/a.js')!;
    assert.equal(r0.code, r0b.code);
    const picks = [0, 1, 2].map((v) => mutateJs(code, 'JSM.arith.swap', v, 'http://x/a.js')!.siteIndex);
    assert.equal(new Set(picks).size, 3);
    assert.match(r0.detail, /^JSM\.arith\.swap at 1:\d+: [-+*/] → [-+*/]$/);
    // variant beyond the number of sites would duplicate another variant
    assert.equal(mutateJs('a = 1 + 2;', 'JSM.arith.swap', 1, 'k'), null);
    assert.ok(mutateJs('a = 1 + 2;', 'JSM.arith.swap', 0, 'k'));
    // no site / not JS / unparsable
    assert.equal(mutateJs('a = 1;', 'JSM.arith.swap', 0, 'k'), null);
    assert.equal(mutateJs('<!doctype html><html><body>404</body></html>', 'JSM.stmt.remove', 0, 'k'), null);
    assert.equal(mutateJs('function (', 'JSM.stmt.remove', 0, 'k'), null);
  });

  test('node budget caps enumeration', () => {
    const code = Array.from({ length: 2000 }, (_, i) => `a${i} = b + ${i};`).join('\n');
    assert.equal(findJsSites(code, 'JSM.arith.swap').length, 2000);
    assert.ok(findJsSites(code, 'JSM.arith.swap', 100).length < 30);
  });

  test('ES modules are parsed and re-checked with the TS parser', () => {
    const code = 'import { x } from "./x.js";\nexport function f(a) { return a + x; }\n';
    const r = mutateJs(code, 'JSM.arith.swap', 0, 'k')!;
    assert.equal(r.code, 'import { x } from "./x.js";\nexport function f(a) { return a - x; }\n');
  });
});

/* ========================================================= end to end */

/** op → [script, original window.__out, mutant window.__out, text expected in the served mutant] */
const E2E: Record<string, [string, unknown, unknown, string]> = {
  'JSM.arith.swap': ['window.__out = 2 + 3;', 5, -1, '2 - 3'],
  'JSM.eq.boundary': ['window.__out = [1, 2, 3].filter(function (x) { return x < 3; }).length;', 2, 3, 'x <= 3'],
  'JSM.cond.false': ['var r = "init"; if (document.documentElement) { r = "branch"; } window.__out = r;', 'branch', 'init', 'if (false)'],
  'JSM.string.empty': ['window.__out = "Saved";', 'Saved', '', '__out = ""'],
  'JSM.method.swap': ['window.__out = "Hello".toUpperCase();', 'HELLO', 'hello', 'toLowerCase'],
  'JSM.optChain.remove': ['var u = null; try { window.__out = String(u?.name); } catch (e) { window.__out = e.name; }', 'undefined', 'TypeError', 'u.name'],
  'JSM.logical.swap': ['var a = 0; window.__out = a || 7;', 7, 0, '(a && 7)'],
  'JSM.return.remove': ['function f() { return 42; } window.__out = f();', 42, undefined, '{(42);}'],
  'JSM.catch.remove': ['try { JSON.parse("{"); window.__out = "parsed"; } catch (e) { window.__out = "handled"; }', 'handled', undefined, 'throw e'],
  'JSM.var.remove': ['(function () { var leaked = 5; })(); window.__out = typeof window.leaked;', 'undefined', 'number', 'leaked = 5'],
  'JSM.number.mutate': ['window.__out = 5;', 5, 'computed', '__out ='],
  'JSM.array.removeElement': ['window.__out = ["a"].join("") + "!";', 'a!', '!', '[]'],
  'JSM.undefined.toNull': ['window.__out = String(undefined);', 'undefined', 'null', 'String(null)'],
  'JSM.this.remove': ['var label = "global"; var o = { label: "obj", get: function () { return this.label; } }; window.__out = o.get();', 'obj', 'global', 'return label'],
};

describe('JSM operators end to end (served script rewritten via applyMutant)', () => {
  let browser: Browser;
  let server: http.Server;
  let base = '';
  const scripts = new Map<string, string>();
  const integrity = new Map<string, string>();

  before(async () => {
    browser = await chromium.launch();
    server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://localhost');
      const m = /^\/js\/(.+)\.js$/.exec(u.pathname);
      if (m && scripts.has(m[1])) {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'max-age=3600' });
        return res.end(scripts.get(m[1]));
      }
      const p = /^\/p\/(.+)$/.exec(u.pathname);
      if (p) {
        const name = p[1];
        const sri = integrity.get(name);
        const tag = `<script src="/js/${name}.js"${sri ? ` integrity="${sri}" crossorigin="anonymous"` : ''}></script>`;
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><html><head>${tag}</head><body><p id="t">-</p></body></html>`);
      }
      if (u.pathname === '/plain.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('a = 1 + 2;');
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await browser.close();
    server.close();
  });

  function mutant(op: string, name: string, variant = 0, pageKey = '*'): MutantDescriptor {
    const def = registry.get(op);
    return {
      id: `${op}@${name}#${variant}`,
      operator: op,
      layer: 'dom',
      target: { kind: 'dom', pageKey, resourceUrl: `${base}/js/${name}.js`, description: `script ${name}` },
      params: { ...def.defaults, variant },
      testFiles: [],
    };
  }

  async function run(name: string, m?: MutantDescriptor) {
    const ctx = await browser.newContext();
    try {
      const h = m ? await applyMutant(ctx, m) : null;
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/p/${name}`);
      await page.waitForLoadState('load');
      const out = await page.evaluate(() => (window as any).__out);
      const served = await page.evaluate((u) => fetch(u).then((r) => r.text()), `${base}/js/${name}.js`);
      return { out, served, applied: h ? h.applied() : [], errors };
    } finally {
      await ctx.close();
    }
  }

  for (const [op, [script, orig, mut, servedText]] of Object.entries(E2E) as [string, [string, unknown, unknown, string]][]) {
    test(op, async () => {
      const name = op.replace(/\./g, '_');
      scripts.set(name, script);
      const expected = mutateJs(script, op, 0, `${base}/js/${name}.js`);
      assert.ok(expected, `${op}: no site in sample script`);
      const original = await run(name);
      assert.deepEqual(original.out, orig, `${op}: original behaviour`);
      assert.deepEqual(original.applied, []);
      assert.equal(original.served, script);

      const res = await run(name, mutant(op, name, 0));
      assert.ok(res.applied.length >= 1, `${op}: not applied`);
      assert.match(res.applied[0], new RegExp(`^${op.replace(/\./g, '\\.')} at 1:\\d+: .+ → .+`));
      assert.equal(res.served, expected.code, `${op}: served script`);
      assert.ok(res.served.includes(servedText), `${op}: served script lacks "${servedText}":\n${res.served}`);
      assertValid(res.served);
      if (op === 'JSM.catch.remove') {
        assert.equal(res.out, undefined);
        assert.ok(res.errors.some((e) => /JSON|Expected/.test(e)), `uncaught error expected, got ${res.errors}`);
      } else if (mut === 'computed') {
        assert.equal(res.out, Number(expected.edit.text));
        assert.notEqual(res.out, orig);
      } else {
        assert.deepEqual(res.out, mut, `${op}: mutant behaviour`);
      }
    });
  }

  test('variant beyond the number of sites: not applied, original served', async () => {
    scripts.set('single', 'window.__out = 2 + 3;');
    const res = await run('single', mutant('JSM.arith.swap', 'single', 2));
    assert.deepEqual(res.applied, []);
    assert.equal(res.out, 5);
    assert.equal(res.served, 'window.__out = 2 + 3;');
  });

  test('mutant scoped to another page is not applied', async () => {
    scripts.set('scoped', 'window.__out = 2 + 3;');
    const other = pageKeyOf(`${base}/p/elsewhere`);
    const res = await run('scoped', mutant('JSM.arith.swap', 'scoped', 0, other));
    assert.deepEqual(res.applied, []);
    assert.equal(res.out, 5);
    const own = pageKeyOf(`${base}/p/scoped`);
    const res2 = await run('scoped', mutant('JSM.arith.swap', 'scoped', 0, own));
    assert.equal(res2.out, -1);
    assert.equal(res2.applied.length >= 1, true);
  });

  test('Subresource Integrity is stripped from the mutated script', async () => {
    const code = 'window.__out = 2 + 3;';
    scripts.set('sri', code);
    integrity.set('sri', 'sha256-' + crypto.createHash('sha256').update(code).digest('base64'));
    const original = await run('sri');
    assert.equal(original.out, 5, 'SRI-protected original script runs');
    const res = await run('sri', mutant('JSM.arith.swap', 'sri', 0));
    assert.equal(res.out, -1, `mutated script blocked? errors: ${res.errors}`);
    assert.ok(res.applied.length >= 1);
  });

  test('dynamically inserted script with integrity is mutated too', async () => {
    const code = 'window.__out = 2 + 3;';
    scripts.set('dyn', code);
    scripts.set('loader', `var s = document.createElement("script"); s.integrity = ${JSON.stringify('sha256-' + crypto.createHash('sha256').update(code).digest('base64'))}; s.crossOrigin = "anonymous"; s.src = "/js/dyn.js"; document.head.appendChild(s);`);
    const ctx = await browser.newContext();
    try {
      const h = await applyMutant(ctx, mutant('JSM.arith.swap', 'dyn', 0));
      const page = await ctx.newPage();
      await page.goto(`${base}/p/loader`);
      await page.waitForFunction(() => (window as any).__out !== undefined, null, { timeout: 5000 });
      assert.equal(await page.evaluate(() => (window as any).__out), -1);
      assert.ok(h.applied().length >= 1);
    } finally {
      await ctx.close();
    }
  });

  test('non-JS response is not mutated', async () => {
    const ctx = await browser.newContext();
    try {
      const m = mutant('JSM.arith.swap', 'x');
      (m.target as { resourceUrl?: string }).resourceUrl = `${base}/plain.txt`;
      const h = await applyMutant(ctx, m);
      const page = await ctx.newPage();
      await page.goto(`${base}/p/single`);
      const body = await page.evaluate((u) => fetch(u).then((r) => r.text()), `${base}/plain.txt`);
      assert.equal(body, 'a = 1 + 2;');
      assert.deepEqual(h.applied(), []);
    } finally {
      await ctx.close();
    }
  });
});
