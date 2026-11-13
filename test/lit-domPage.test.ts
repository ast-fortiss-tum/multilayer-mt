import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { applyDomMutation } from '../src/runtime/instrument';
import { DOM_PAGE_OPERATORS } from '../src/operators/lit/domPage';
import { registry, DomOperatorDef } from '../src/operators/registry';
import type { ElementInfo } from '../src/types';

const ORIGIN = 'http://mlmt.test';

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

/** Minimal jQuery look-alike (enough for the jQuery-trapping operators). */
const FAKE_JQ = `<script>(function(){
  function jQuery(sel){ return new jQuery.fn.init(sel); }
  jQuery.fn = jQuery.prototype = {
    jquery: 'fake-3',
    each: function(f){ for (var i = 0; i < this.length; i++) f(this[i]); return this; },
    addClass: function(c){ return this.each(function(e){ e.classList.add(c); }); },
    attr: function(n, v){ if (v === undefined) return this[0] ? this[0].getAttribute(n) : undefined; return this.each(function(e){ e.setAttribute(n, v); }); },
  };
  jQuery.fn.init = function(sel){ var els = typeof sel === 'string' ? document.querySelectorAll(sel) : []; this.length = els.length; for (var i = 0; i < els.length; i++) this[i] = els[i]; };
  jQuery.fn.init.prototype = jQuery.fn;
  jQuery.ajax = function(o){ setTimeout(function(){ if (/bad/.test(o.url)) { if (o.error) o.error('err'); } else if (o.success) o.success(o.url); }, 0); };
  window.jQuery = window.$ = jQuery;
})();</script>`;

interface Run {
  ctx: BrowserContext;
  page: Page;
  applied: () => string[];
  out: () => Promise<any>;
}

/**
 * Serve `pages` (path -> html) on mlmt.test, inject the mutation through the
 * public API, open `path`. /api/* echoes "<METHOD> <path>".
 */
async function run(operator: string, pages: Record<string, string> | string, o: { params?: Record<string, unknown>; pageKey?: string; resourceUrl?: string; path?: string; wait?: number; mutate?: boolean } = {}): Promise<Run> {
  const map = typeof pages === 'string' ? { '/page': pages } : pages;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.route(`${ORIGIN}/**`, (route) => {
    const u = new URL(route.request().url());
    if (map[u.pathname] !== undefined) {
      const ct = u.pathname.endsWith('.js') ? 'application/javascript' : u.pathname.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({ contentType: ct, body: map[u.pathname] });
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/plain', body: `${route.request().method()} ${u.pathname}` });
    return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>not found</h1>' });
  });
  const h = o.mutate === false ? { applied: () => [] as string[] } : await applyDomMutation(ctx, { operator, params: o.params, pageKey: o.pageKey, resourceUrl: o.resourceUrl });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + (o.path ?? Object.keys(map)[0]));
  await page.waitForTimeout(o.wait ?? 100);
  return { ctx, page, applied: () => h.applied(), out: () => page.evaluate(() => (window as any).__out) };
}

const html = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const script = (js: string) => `<script>${js}</script>`;

async function check(operator: string, page: string | Record<string, string>, expected: unknown, o: Parameters<typeof run>[2] = {}): Promise<Run> {
  const r = await run(operator, page, o);
  assert.deepEqual(await r.out(), expected);
  assert.ok(r.applied().length > 0, `${operator} should report an application`);
  return r;
}

async function noReport(operator: string, page: string, o: Parameters<typeof run>[2] = {}): Promise<void> {
  const r = await run(operator, page, o);
  assert.deepEqual(r.applied(), [], `${operator} must not report: ${r.applied().join('; ')}`);
  await r.ctx.close();
}

const done = async (r: Run) => r.ctx.close();

test('every Batch C operator is registered with refs, aliases and a page scope', () => {
  assert.equal(DOM_PAGE_OPERATORS.length, 45);
  for (const op of DOM_PAGE_OPERATORS as DomOperatorDef[]) {
    assert.ok(registry.has(op.id), op.id);
    assert.equal(op.scope, 'page', op.id);
    assert.ok(op.refs && op.refs.length && op.aliases && op.aliases.length && op.intent, op.id);
    assert.ok(op.apply || op.nodeApply, op.id);
    if (op.apply) assert.doesNotThrow(() => new Function(`return (${op.apply!.toString()})`), op.id);
  }
});

/* ------------------------------------------------------------ Mutandis */

test('MDA.parseInt.radix', async () => {
  await done(await check('MDA.parseInt.radix', html(script(`window.__out = parseInt('10', 2);`)), 10));
  await noReport('MDA.parseInt.radix', html(script(`window.__out = parseInt('10', 10);`)));
});

test('MDA.replace.global', async () => {
  await done(await check('MDA.replace.global', html(script(`window.__out = 'a-b-c'.replace(/-/g, '+');`)), 'a+b-c'));
  await noReport('MDA.replace.global', html(script(`window.__out = 'a-b'.replace(/-/g, '+');`)));
});

test('MDA.timer.immediate', async () => {
  await done(await check('MDA.timer.immediate', html(script(`var x = 'before'; setTimeout(function(){ x = 'fired'; }, 1000); window.__out = x;`)), 'fired'));
});

test('MDA.timer.noArgs', async () => {
  await done(await check('MDA.timer.noArgs', html(script(`setTimeout(function(a){ window.__out = a === undefined ? 'none' : a; }, 10, 'arg');`)), 'none'));
  await noReport('MDA.timer.noArgs', html(script(`setTimeout(function(){ window.__out = 1; }, 10);`)));
});

test('MDA.dom.insertSwap', async () => {
  const page = html(
    '<div id="p"><i id="a"></i><i id="b"></i></div>',
    script(`document.addEventListener('DOMContentLoaded', function(){ var p = document.getElementById('p');
      p.insertBefore(document.getElementById('b'), document.getElementById('a'));
      window.__out = Array.from(p.children).map(function(c){ return c.id; }).join(''); });`),
  );
  await done(await check('MDA.dom.insertSwap', page, 'ab'));
});

test('MDA.dom.getByIdNull', async () => {
  await done(await check('MDA.dom.getByIdNull', html('<div id="x"></div>' + script(`window.__out = document.getElementById('x') === null;`)), true));
});

test('MDA.dom.attrName', async () => {
  const page = html('<div id="x"></div>' + script(`var e = document.querySelector('#x'); e.setAttribute('title', 't'); window.__out = [e.hasAttribute('title'), e.hasAttribute('title-mut')];`));
  await done(await check('MDA.dom.attrName', page, [false, true]));
});

test('MDA.dom.attrValue', async () => {
  const page = html('<div id="x"></div>' + script(`var e = document.querySelector('#x'); e.setAttribute('title', 't'); window.__out = e.getAttribute('title');`));
  await done(await check('MDA.dom.attrValue', page, 'tMut'));
});

test('MDA.dom.innerHtmlText', async () => {
  const page = html('<div id="x"></div>' + script(`var e = document.querySelector('#x'); e.innerHTML = '<b>bold</b>'; window.__out = [!!e.querySelector('b'), e.textContent];`));
  await done(await check('MDA.dom.innerHtmlText', page, [false, '<b>bold</b>']));
  await noReport('MDA.dom.innerHtmlText', html('<div id="x"></div>' + script(`document.querySelector('#x').innerHTML = 'plain';`)));
});

test('MDA.jq.selectorSwap', async () => {
  const page = html('<div id="a"></div>' + FAKE_JQ + script(`window.__out = $('#a').length;`));
  await done(await check('MDA.jq.selectorSwap', page, 0));
});

test('MDA.jq.nameChange', async () => {
  const page = html('<div id="a"></div>' + FAKE_JQ + script(`$('#a').addClass('on'); window.__out = document.getElementById('a').className;`));
  await done(await check('MDA.jq.nameChange', page, 'on-mut'));
});

test('MDA.xhr.method', async () => {
  await done(await check('MDA.xhr.method', html(script(`fetch('/api/x').then(function(r){ return r.text(); }).then(function(t){ window.__out = t; });`)), 'POST /api/x', { wait: 300 }));
  const xhr = html(script(`var x = new XMLHttpRequest(); x.open('POST', '/api/y'); x.onload = function(){ window.__out = x.responseText; }; x.send('a=1');`));
  await done(await check('MDA.xhr.method', xhr, 'GET /api/y', { wait: 300 }));
});

test('MDA.xhr.url', async () => {
  const page = html(script(`fetch('/api/a').then(function(){ return fetch('/api/b'); }).then(function(r){ return r.text(); }).then(function(t){ window.__out = t; });`));
  await done(await check('MDA.xhr.url', page, 'GET /api/a', { params: { nth: 2 }, wait: 300 }));
  await done(await check('MDA.xhr.url', html(script(`fetch('/api/a').then(function(r){ return r.text(); }).then(function(t){ window.__out = t; });`)), 'GET /api/a_mut', { wait: 300 }));
});

test('MDA.xhr.sync', async () => {
  const page = html(script(`var x = new XMLHttpRequest(); x.open('GET', '/api/s'); x.send(); window.__out = x.readyState;`));
  await done(await check('MDA.xhr.sync', page, 4, { wait: 300 }));
});

/* ---------------------------------------------------------- AjaxMutator */

const BUTTONS = '<button id="b1">1</button><button id="b2">2</button>';
const clickBoth = `window.__clk = function(id){ document.getElementById(id).click(); };`;

test('AJM.event.type', async () => {
  const page = html(BUTTONS + script(`document.getElementById('b1').addEventListener('click', function(){ window.__out = (window.__out || '') + 'h'; });`));
  const r = await check('AJM.event.type', page, undefined);
  await r.page.evaluate(() => document.getElementById('b1')!.click());
  assert.equal(await r.out(), undefined);
  await r.page.evaluate(() => document.getElementById('b1')!.dispatchEvent(new MouseEvent('mouseover')));
  assert.equal(await r.out(), 'h');
  await done(r);
});

test('AJM.event.target', async () => {
  const page = html(BUTTONS + script(`window.__out = [];
    document.getElementById('b1').addEventListener('click', function(){ window.__out.push('f1'); });
    document.getElementById('b2').addEventListener('click', function(){ window.__out.push('f2'); });` + clickBoth));
  const r = await check('AJM.event.target', page, []);
  await r.page.evaluate(() => { (window as any).__clk('b2'); (window as any).__clk('b1'); });
  assert.deepEqual(await r.out(), ['f1', 'f2']);
  await done(r);
});

test('AJM.event.callback', async () => {
  const page = html(BUTTONS + script(`window.__out = [];
    document.getElementById('b1').addEventListener('click', function(){ window.__out.push('f1'); });
    document.getElementById('b2').addEventListener('click', function(){ window.__out.push('f2'); });` + clickBoth));
  const r = await check('AJM.event.callback', page, []);
  await r.page.evaluate(() => { (window as any).__clk('b2'); (window as any).__clk('b1'); });
  assert.deepEqual(await r.out(), ['f1', 'f1']);
  await done(r);
});

test('AJM.timer.duration', async () => {
  const page = html(script(`window.__out = []; setTimeout(function(){ window.__out.push('a'); }, 50); setTimeout(function(){ window.__out.push('b'); }, 100);`));
  await done(await check('AJM.timer.duration', page, ['b', 'a'], { wait: 400 }));
});

test('AJM.timer.callback', async () => {
  const page = html(script(`window.__out = []; setTimeout(function(){ window.__out.push('a'); }, 10); setTimeout(function(){ window.__out.push('b'); }, 20);`));
  await done(await check('AJM.timer.callback', page, ['a', 'a'], { params: { nth: 2 }, wait: 200 }));
});

test('AJM.ajax.handlerSwap', async () => {
  const page = html(FAKE_JQ + script(`$.ajax({ url: '/ok', success: function(){ window.__out = 'success'; }, error: function(){ window.__out = 'error'; } });`));
  await done(await check('AJM.ajax.handlerSwap', page, 'error'));
});

test('AJM.ajax.successSwap', async () => {
  const page = html(FAKE_JQ + script(`window.__out = [];
    $.ajax({ url: '/one', success: function(u){ window.__out.push('s1:' + u); } });
    $.ajax({ url: '/two', success: function(u){ window.__out.push('s2:' + u); } });`));
  await done(await check('AJM.ajax.successSwap', page, ['s1:/one', 's1:/two']));
});

test('AJM.dom.selectNearby', async () => {
  const page = html('<div id="parent"><span id="child"></span></div>' + script(`window.__out = document.querySelector('#child').id;`));
  await done(await check('AJM.dom.selectNearby', page, 'parent'));
});

test('AJM.dom.appendWrong', async () => {
  const page = html('<div id="c"></div>' + script(`var c = document.getElementById('c'); var a = document.createElement('i'); a.textContent = 'A';
    var b = document.createElement('i'); b.textContent = 'B'; c.appendChild(a); c.appendChild(b); window.__out = c.textContent;`));
  await done(await check('AJM.dom.appendWrong', page, 'AA'));
});

test('AJM.dom.removeNoop', async () => {
  const page = html('<div id="x"></div>' + script(`document.addEventListener('DOMContentLoaded', function(){ document.getElementById('x').remove(); window.__out = !!document.getElementById('x'); });`));
  await done(await check('AJM.dom.removeNoop', page, true));
  // before DOMContentLoaded removals still work
  await noReport('AJM.dom.removeNoop', html('<div id="x"></div>' + script(`document.getElementById('x').remove();`)));
});

test('AJM.dom.cloneShallow', async () => {
  const page = html('<div id="x"><b>1</b><b>2</b></div>' + script(`window.__out = document.getElementById('x').cloneNode(true).childNodes.length;`));
  await done(await check('AJM.dom.cloneShallow', page, 0));
});

test('AJM.dom.normalizeNoop', async () => {
  const page = html('<div id="x"></div>' + script(`var d = document.getElementById('x'); d.appendChild(document.createTextNode('a')); d.appendChild(document.createTextNode('b')); d.normalize(); window.__out = d.childNodes.length;`));
  await done(await check('AJM.dom.normalizeNoop', page, 2));
});

/* ---------------------------------------------------------- JSPreventer */

test('JSP.ajax.delay', async () => {
  const page = html(script(`var t0 = performance.now(); window.__out = {};
    fetch('/api/f').then(function(){ window.__out.fetch = performance.now() - t0; });
    var x = new XMLHttpRequest(); x.open('GET', '/api/x'); x.onload = function(){ window.__out.xhr = performance.now() - t0; }; x.send();`));
  const r = await run('JSP.ajax.delay', page, { params: { delayMs: 500 }, wait: 900 });
  const o = await r.out();
  assert.ok(o.fetch >= 480 && o.xhr >= 480, JSON.stringify(o));
  assert.ok(r.applied().length >= 2);
  await done(r);
});

test('JSP.script.delay', async () => {
  const pages = { '/page': html('<script src="/s.js"></script>' + script(`window.__out = window.__t;`)), '/s.js': 'window.__t = performance.now();' };
  const r = await run('JSP.script.delay', pages, { resourceUrl: `${ORIGIN}/s.js`, params: { delayMs: 600 } });
  assert.ok((await r.out()) >= 550, String(await r.out()));
  assert.ok(r.applied().length > 0);
  await done(r);
  const r2 = await run('JSP.script.delay', pages, { resourceUrl: `${ORIGIN}/s.js`, params: { delayMs: 600 }, pageKey: `${ORIGIN}/other` });
  assert.deepEqual(r2.applied(), []);
  await done(r2);
});

/* ---------------------------------------------------------------- MUTEC */

test('SEC.escape.identity', async () => {
  await done(await check('SEC.escape.identity', html(script(`window.__out = [encodeURIComponent('a b&c'), encodeURI('x y'), escape('<')];`)), ['a b&c', 'x y', '<']));
  await noReport('SEC.escape.identity', html(script(`window.__out = encodeURIComponent('abc');`)));
});

/* ----------------------------------------------------------- navigation */

test('WNV.back.fail', async () => {
  const r = await run('WNV.back.fail', { '/p1': html('<h1>p1</h1>'), '/p2': html('<h1>p2</h1>') }, { path: '/p1' });
  await r.page.goto(`${ORIGIN}/p2`);
  await r.page.waitForTimeout(100);
  assert.equal(new URL(r.page.url()).pathname, '/p2');
  await r.page.goBack().catch(() => null);
  await r.page.waitForURL(/mlmt-fob-404/);
  await r.page.waitForLoadState('load');
  assert.equal(await r.page.textContent('h1'), 'not found');
  assert.ok(r.applied().some((d) => d.includes('back navigation')));
  await done(r);
});

test('WNV.reload.fail', async () => {
  const r = await run('WNV.reload.fail', { '/p1': html('<h1>p1</h1>') }, { path: '/p1' });
  assert.equal(new URL(r.page.url()).pathname, '/mlmt-fob-404');
  assert.ok(r.applied().length > 0);
  await r.page.reload();
  assert.equal(await r.page.textContent('h1'), 'not found');
  await done(r);
});

/* --------------------------------------------------------- accessibility */

test('A11.page.lowContrast', async () => {
  const r = await check('A11.page.lowContrast', html('<p id="t">text</p>'), undefined);
  assert.equal(await r.page.evaluate(() => getComputedStyle(document.getElementById('t')!).color), 'rgb(255, 255, 255)');
  await done(r);
});

test('A11.page.title', async () => {
  const r = await check('A11.page.title', html(script(`setTimeout(function(){ document.title = 'Changed'; }, 30);`), '<title>Home</title>'), undefined, { wait: 200 });
  const t = await r.page.title();
  assert.ok(t !== 'Home' && t !== 'Changed' && t.length === 10, t);
  await done(r);
});

test('A11.ids.duplicate', async () => {
  const r = await check('A11.ids.duplicate', html('<div id="a"></div><div id="b"></div><div id="c"></div>'), undefined);
  const ids = await r.page.evaluate(() => Array.from(document.querySelectorAll('[id]')).map((e) => e.id));
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 2);
  await done(r);
  const op = registry.get('A11.ids.duplicate') as DomOperatorDef;
  const el = (id?: string) => ({ attrs: id ? { id } : {} }) as unknown as ElementInfo;
  assert.equal(op.pageApplicable!([el('a'), el('b')], {}), true);
  assert.equal(op.pageApplicable!([el('a'), el()], {}), false);
});

/* ------------------------------------------------------------ CSS rules */

const BOX = (css: string) => html('<div id="box">box</div>', `<style>${css}</style>`);
const boxStyle = (p: Page, prop: string) => p.evaluate((pr) => getComputedStyle(document.getElementById('box')!).getPropertyValue(pr), prop);

test('CSS.decl.value', async () => {
  const r = await check('CSS.decl.value', BOX('#box { width: 100px } .absent { width: 5px }'), undefined);
  const w = parseFloat(await boxStyle(r.page, 'width'));
  assert.ok(w !== 100 && Math.abs(w - 100) <= 10, String(w));
  await done(r);
  await noReport('CSS.decl.value', BOX('.absent { width: 5px } #box { color: red }'));
});

test('CSS.decl.unit', async () => {
  const r = await check('CSS.decl.unit', BOX('#box { width: 10px }'), undefined);
  assert.equal(await boxStyle(r.page, 'width'), '160px');
  await done(r);
});

test('CSS.decl.value (external same-origin stylesheet)', async () => {
  const pages = { '/page': html('<div id="box">box</div>', '<link rel="stylesheet" href="/s.css">'), '/s.css': '#box { height: 50px }' };
  const r = await run('CSS.decl.value', pages);
  const hgt = parseFloat(await boxStyle(r.page, 'height'));
  assert.ok(hgt !== 50 && Math.abs(hgt - 50) <= 10, String(hgt));
  assert.ok(r.applied().length > 0);
  await done(r);
});

test('CSS.media.feature', async () => {
  const r = await check('CSS.media.feature', BOX('#box { color: rgb(0, 0, 255) } @media (min-width: 500px) { #box { color: rgb(255, 0, 0) } }'), undefined);
  assert.equal(await boxStyle(r.page, 'color'), 'rgb(0, 0, 255)');
  assert.match(await r.page.evaluate(() => (document.styleSheets[0].cssRules[1] as CSSMediaRule).media.mediaText), /max-width: 500px/);
  await done(r);
});

test('CSS.media.breakpoint', async () => {
  const r = await check('CSS.media.breakpoint', BOX('@media (min-width: 500px) { #box { color: red } }'), undefined);
  assert.match(await r.page.evaluate(() => (document.styleSheets[0].cssRules[0] as CSSMediaRule).media.mediaText), /min-width: (498|502)px/);
  await done(r);
  await noReport('CSS.media.breakpoint', BOX('#box { color: red }'));
});

/* -------------------------------------------------------------- viewport */

const VPAGE = html('<p>viewport</p>');
const size = (p: Page) => p.evaluate(() => [window.innerWidth, window.innerHeight, Math.round(document.body.getBoundingClientRect().width)]);

for (const [id, w, hgt, fixedBody] of [
  ['GUI.viewport.expand', 1920, 1080, false],
  ['GUI.viewport.reduce', 768, 432, false],
  ['GUI.viewport.expandFixed', 1920, 1080, true],
  ['GUI.viewport.reduceFixed', 768, 432, true],
  ['GUI.viewport.hide', 360, 240, false],
] as const) {
  test(id, async () => {
    const r = await run(id, VPAGE, { pageKey: `${ORIGIN}/page` });
    const [iw, ih, bw] = await size(r.page);
    assert.deepEqual([iw, ih], [w, hgt]);
    if (fixedBody) assert.equal(bw, 1280);
    else assert.equal(bw, w - 16); // default body margin
    assert.ok(r.applied().length > 0);
    // another page key: original viewport restored, no fixed width
    await r.page.goto(`${ORIGIN}/other`);
    await r.page.waitForTimeout(100);
    assert.deepEqual(await size(r.page), [1280, 720, 1264]);
    await done(r);
  });
}

test('GUI.viewport.expand is not applied on other pages', async () => {
  await noReport('GUI.viewport.expand', VPAGE, { pageKey: `${ORIGIN}/elsewhere` });
});

/* ----------------------------------------------------------- environment */

test('ENV.cpu.throttle', async () => {
  const BUSY = html(script(`window.__busy = function(){ var t = performance.now(); var x = 0; for (var i = 0; i < 3e7; i++) x += i % 7; window.__x = x; return performance.now() - t; };`));
  const base = await run('ENV.cpu.throttle', BUSY, { mutate: false });
  const t0 = await base.page.evaluate(() => (window as any).__busy());
  await done(base);
  const r = await run('ENV.cpu.throttle', BUSY);
  const t1 = await r.page.evaluate(() => (window as any).__busy());
  assert.ok(t1 > t0 * 2, `throttled ${t1} ms vs ${t0} ms`);
  assert.ok(r.applied().some((d) => d.includes('CPU throttled 6x')));
  await done(r);
});

test('ENV.network.throttle', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(html('<p>net</p>'));
    } else res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const timeFetch = (p: Page) => p.evaluate(async () => { const t = performance.now(); await (await fetch('/data?' + Math.random())).text(); return performance.now() - t; });
    const ctx0 = await browser.newContext();
    const p0 = await ctx0.newPage();
    await p0.goto(url);
    const t0 = await timeFetch(p0);
    await ctx0.close();
    const ctx = await browser.newContext();
    const h = await applyDomMutation(ctx, { operator: 'ENV.network.throttle' });
    const p = await ctx.newPage();
    await p.goto(url);
    const t1 = await timeFetch(p);
    assert.ok(t1 >= 350 && t1 > t0 + 200, `throttled ${t1} ms vs ${t0} ms`);
    assert.ok(h.applied().some((d) => d.includes('network throttled')));
    await ctx.close();
  } finally {
    server.close();
  }
});
