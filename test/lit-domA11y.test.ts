import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { mlmtDomMutator, DomMutationSpec } from '../src/browser/domMutator';
import { DOM_A11Y_VISUAL_OPERATORS } from '../src/operators/lit/domA11y';
import type { DomOperatorDef } from '../src/operators/registry';
import type { ElementInfo } from '../src/types';

const URL_ = 'http://mlmt.test/page';
// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const HTML = `<!doctype html><html><head><style>a.plain{text-decoration:none;cursor:default}</style></head><body>
<h2 id="h">Section title</h2>
<h2 id="hmix">Mixed <em>title</em></h2>
<img id="logo" class="brand" src="/logo.png" alt="Company logo" title="Logo" aria-label="Logo" width="40" height="30">
<a id="imglink" href="/home" aria-label="Home" title="Home"><img src="/logo.png" alt="Home" width="20" height="20"></a>
<p id="para">Hello world</p>
<span id="word">Hello</span>
<span id="one">x</span>
<nav id="menu"><ul id="list"><li><a href="/a">A</a></li><li><a href="/b">B</a></li><li><a href="/c">C</a></li></ul></nav>
<div id="single"><a href="/only">Only</a></div>
<p>Read <a id="link" href="/next" class="lnk">the <b>next</b> page</a> now.</p>
<a id="plain" class="plain" href="/x">plain</a>
<table id="tbl"><thead><tr><th id="th1" scope="col" colspan="1">Name</th><th scope="col">Age</th></tr></thead><tbody><tr><td id="td1">Ann</td><td>3</td></tr></tbody></table>
<table id="nohead"><tr><td>x</td></tr></table>
<button id="btn" onclick="window.hits=(window.hits||0)+1">Save</button>
<div id="box" style="width:100px;height:40px;background:#eee;border:1px solid black;color:black">Box text</div>
<span id="inl">inline</span>
<form id="form" action="/submit">
  <label for="email">Email</label>
  <input id="email" type="email" placeholder="you@x.org">
  <label>Name <input id="name" type="text"></label>
  <input id="plainin" type="text" size="20">
  <select id="sel"><option value="1">One</option><option value="2">Two</option></select>
  <input id="r1" type="radio" name="r" value="1">
  <textarea id="ta"></textarea>
  <button id="submit" type="submit">Send</button>
</form>
<div id="later"></div>
</body></html>`;

let browser: Browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

const OPS = DOM_A11Y_VISUAL_OPERATORS as DomOperatorDef[];
const opById = (id: string) => {
  const o = OPS.find((x) => x.id === id);
  if (!o) throw new Error('missing operator ' + id);
  return o;
};

/** As runtime/instrument.ts normaliseFn: method shorthand is not an expression. */
function fnSource(f: Function): string {
  const src = f.toString();
  if (/^(async\s+)?function\b/.test(src) || /^(async\s*)?(\([^)]*\)|[\w$]+)\s*=>/.test(src)) return src;
  return `function ${src}`;
}

async function run(
  operator: string,
  selector: string,
  o: { params?: Record<string, any>; seed?: number; html?: string } = {},
): Promise<{ page: Page; ctx: BrowserContext; applied: string[] }> {
  const op = opById(operator);
  const ctx = await browser.newContext();
  const applied: string[] = [];
  await ctx.exposeBinding('__mlmtApplied', (_s, info: any) => { applied.push(info.detail); });
  await ctx.route('http://mlmt.test/**', (route) => {
    const u = route.request().url();
    if (u.endsWith('/page')) return route.fulfill({ contentType: 'text/html', body: o.html ?? HTML });
    if (u.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: PNG });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>other</title>' });
  });
  const spec: DomMutationSpec = {
    operator, pageKey: URL_, pageKeyQuery: 'all', selector, params: { ...op.defaults, ...(o.params || {}) }, seed: o.seed ?? 7, scope: 'element',
  };
  await ctx.addInitScript({ content: `(${mlmtDomMutator.toString()})(${JSON.stringify(spec)}, ${fnSource(op.apply!)});` });
  const page = await ctx.newPage();
  await page.goto(URL_);
  await page.waitForLoadState('load');
  await page.waitForTimeout(50);
  return { page, ctx, applied };
}

async function trackOpen(p: Page) {
  await p.evaluate(() => {
    (window as any).__opened = [];
    window.open = ((u: string) => { (window as any).__opened.push(u); return null; }) as any;
  });
}
const opened = (p: Page) => p.evaluate(() => (window as any).__opened as string[]);

/* ----------------------------------------------------------------- metadata */

const EXPECTED = [
  'A11.img.toDiv', 'A11.alt.random', 'A11.img.unlabel', 'A11.heading.toP', 'A11.text.spaced', 'A11.link.toSpan', 'A11.th.toTd',
  'A11.link.undecorate', 'A11.input.smallFont', 'A11.text.vhFont', 'A11.link.noOutline', 'A11.text.blink', 'A11.nav.reverseTab',
  'A11.imgLink.unlabel', 'A11.click.toMousedown', 'A11.button.ariaMismatch', 'A11.focus.blur', 'A11.click.openWindow',
  'A11.blur.openWindow', 'A11.input.autoSubmit', 'A11.select.openWindow', 'A11.input.unname',
  'VPS.color.change', 'VPS.size.change', 'VPS.position.change', 'VPS.visibility.change', 'VPS.text.change',
  'VPS.decoration.change', 'VPS.htmlattr.change',
];

test('every planned operator is defined with complete metadata', () => {
  assert.deepEqual(OPS.map((o) => o.id).sort(), [...EXPECTED].sort());
  for (const o of OPS) {
    assert.equal(o.layer, 'dom', o.id);
    assert.equal(o.scope, 'element', o.id);
    assert.equal(o.set, 'literature', o.id);
    assert.equal(o.family, o.id.split('.')[0], o.id);
    assert.ok(o.intent && o.category && o.refs?.length && o.aliases?.length, o.id);
    assert.equal(typeof o.apply, 'function', o.id);
    assert.equal(typeof o.applicable, 'function', o.id);
    // serialisable: the source must compile on its own
    assert.doesNotThrow(() => new Function(`return (${fnSource(o.apply!)})`), o.id);
  }
});

function info(tag: string, attrs: Record<string, string> = {}, extra: { text?: string; visibility?: Partial<ElementInfo['visibility']>; facts?: Partial<ElementInfo['facts']> } = {}): ElementInfo {
  return {
    selector: '#x', tag, attrs, text: extra.text ?? '',
    visibility: { inViewport: true, displayed: true, opaque: true, nonZeroSize: true, ...(extra.visibility || {}) },
    facts: {
      textNodeWords: 0, childElementCount: 0, inForm: false, formSelector: null, formControlCount: 0, hasImgDescendant: false,
      hasImgWithAlt: false, associatedLabel: false, implicitRole: null, ...(extra.facts || {}),
    },
  };
}
const ok = (id: string, el: ElementInfo) => opById(id).applicable!(el, opById(id).defaults);

test('applicable predicates', () => {
  assert.ok(ok('A11.img.toDiv', info('img', { alt: 'x' })));
  assert.ok(!ok('A11.img.toDiv', info('img', { alt: 'x' }, { facts: { inLink: true } })));
  assert.ok(!ok('A11.img.toDiv', info('img', { alt: ' ' })));
  assert.ok(ok('A11.img.unlabel', info('img', { title: 't' })));
  assert.ok(!ok('A11.img.unlabel', info('img', {})));
  assert.ok(ok('A11.heading.toP', info('h3', {}, { text: 'T', facts: { isLeaf: true } })));
  assert.ok(!ok('A11.heading.toP', info('h3', {}, { text: 'T', facts: { isLeaf: false } })));
  assert.ok(!ok('A11.text.spaced', info('input', {}, { text: 'ab' })));
  assert.ok(!ok('A11.text.spaced', info('span', {}, { text: 'a' })));
  assert.ok(ok('A11.link.toSpan', info('a', { href: '/' })));
  assert.ok(!ok('A11.link.toSpan', info('a', {})));
  assert.ok(ok('A11.th.toTd', info('th')) && !ok('A11.th.toTd', info('td')));
  assert.ok(ok('A11.input.smallFont', info('select')) && !ok('A11.input.smallFont', info('input', { type: 'hidden' })));
  assert.ok(ok('A11.click.toMousedown', info('div', { onclick: 'f()' })) && !ok('A11.click.toMousedown', info('div')));
  assert.ok(ok('A11.button.ariaMismatch', info('input', { type: 'submit' })) && !ok('A11.button.ariaMismatch', info('input', { type: 'text' })));
  assert.ok(ok('A11.focus.blur', info('div', { tabindex: '0' })) && !ok('A11.focus.blur', info('div')));
  assert.ok(!ok('A11.focus.blur', info('button', { disabled: '' })));
  assert.ok(ok('A11.input.autoSubmit', info('input', { type: 'text' }, { facts: { inForm: true } })));
  assert.ok(!ok('A11.input.autoSubmit', info('input', { type: 'text' })));
  assert.ok(!ok('A11.input.autoSubmit', info('input', { type: 'submit' }, { facts: { inForm: true } })));
  assert.ok(ok('A11.imgLink.unlabel', info('a', { href: '/' }, { facts: { hasImgDescendant: true } })));
  assert.ok(!ok('A11.imgLink.unlabel', info('a', { href: '/' })));
  assert.ok(ok('A11.select.openWindow', info('select')) && !ok('A11.select.openWindow', info('input', { type: 'text' })));
  assert.ok(ok('VPS.color.change', info('div')));
  assert.ok(!ok('VPS.color.change', info('div', {}, { visibility: { displayed: false } })));
  assert.ok(!ok('VPS.size.change', info('div', {}, { visibility: { nonZeroSize: false } })));
  assert.ok(ok('VPS.htmlattr.change', info('img')) && ok('VPS.htmlattr.change', info('input', { type: 'text' })));
  assert.ok(!ok('VPS.htmlattr.change', info('div')) && !ok('VPS.htmlattr.change', info('input', { type: 'checkbox' })));
});

/* ------------------------------------------------------------------- Ma11y */

test('A11.img.toDiv replaces the image by a background <div> of the same size', async () => {
  const { page, ctx, applied } = await run('A11.img.toDiv', '#logo');
  assert.equal(applied.length, 1);
  const d = await page.$eval('#logo', (e) => ({
    tag: e.tagName, w: (e as HTMLElement).offsetWidth, h: (e as HTMLElement).offsetHeight, bg: getComputedStyle(e).backgroundImage,
    alt: e.getAttribute('alt'), cls: e.className, text: e.textContent, mark: e.getAttribute('data-mlmt-mutated'),
  }));
  assert.deepEqual(d, { tag: 'DIV', w: 40, h: 30, bg: 'url("http://mlmt.test/logo.png")', alt: null, cls: 'brand', text: '', mark: 'A11.img.toDiv' });
  assert.equal(await page.getByAltText('Company logo').count(), 0);
  await ctx.close();
});

test('A11.img.toDiv: not applied to images inside links', async () => {
  const { ctx, applied } = await run('A11.img.toDiv', '#imglink img');
  assert.deepEqual(applied, []);
  await ctx.close();
});

test('A11.alt.random', async () => {
  const { page, ctx, applied } = await run('A11.alt.random', '#logo');
  const alt = await page.getAttribute('#logo', 'alt');
  assert.match(alt!, /^[a-z0-9]{6}$/);
  assert.equal(applied.length, 1);
  const again = await run('A11.alt.random', '#logo');
  assert.equal(await again.page.getAttribute('#logo', 'alt'), alt, 'same seed, same mutant');
  await ctx.close();
  await again.ctx.close();
});

test('A11.img.unlabel', async () => {
  const { page, ctx, applied } = await run('A11.img.unlabel', '#logo');
  for (const a of ['alt', 'aria-label', 'title']) assert.equal(await page.getAttribute('#logo', a), null);
  assert.deepEqual(applied, ['removed alt, aria-label, title']);
  await ctx.close();
});

test('A11.heading.toP', async () => {
  const { page, ctx, applied } = await run('A11.heading.toP', '#h');
  const d = await page.$eval('#h', (e) => ({ tag: e.tagName, text: e.textContent, fw: getComputedStyle(e).fontWeight }));
  assert.deepEqual(d, { tag: 'P', text: 'Section title', fw: '700' });
  assert.equal(await page.getByRole('heading', { name: 'Section title' }).count(), 0);
  assert.equal(applied.length, 1);
  await ctx.close();
  const mixed = await run('A11.heading.toP', '#hmix');
  assert.deepEqual(mixed.applied, []);
  await mixed.ctx.close();
});

test('A11.text.spaced', async () => {
  const { page, ctx, applied } = await run('A11.text.spaced', '#word');
  assert.equal(await page.textContent('#word'), 'H e l l o');
  assert.equal(applied.length, 1);
  await ctx.close();
  const one = await run('A11.text.spaced', '#one');
  assert.deepEqual(one.applied, []);
  await one.ctx.close();
});

test('A11.link.toSpan keeps children and still navigates on click', async () => {
  const { page, ctx, applied } = await run('A11.link.toSpan', '#link');
  const d = await page.$eval('#link', (e) => ({ tag: e.tagName, html: e.innerHTML, href: e.getAttribute('href'), cls: e.className, td: getComputedStyle(e).textDecorationLine }));
  assert.deepEqual(d, { tag: 'SPAN', html: 'the <b>next</b> page', href: null, cls: 'lnk', td: 'underline' });
  assert.equal(await page.getByRole('link', { name: 'the next page' }).count(), 0);
  assert.equal(applied.length, 1);
  await Promise.all([page.waitForURL('**/next'), page.click('#link')]);
  await ctx.close();
});

test('A11.th.toTd converts every header cell of the table, also late ones', async () => {
  const { page, ctx, applied } = await run('A11.th.toTd', '#tbl');
  assert.equal(await page.locator('#tbl th').count(), 0);
  assert.deepEqual(await page.$eval('#th1', (e) => [e.tagName, e.getAttribute('scope'), e.getAttribute('colspan'), e.textContent]), ['TD', null, '1', 'Name']);
  assert.deepEqual(applied, ['2 <th> -> <td>']);
  await page.evaluate(() => { const tr = document.createElement('tr'); tr.innerHTML = '<th>Late</th>'; document.querySelector('#tbl tbody')!.appendChild(tr); });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#tbl th').count(), 0);
  assert.equal(applied.length, 2);
  await ctx.close();
  const none = await run('A11.th.toTd', '#nohead');
  assert.deepEqual(none.applied, []);
  await none.ctx.close();
});

test('A11.link.undecorate (also on hover)', async () => {
  const { page, ctx, applied } = await run('A11.link.undecorate', '#link');
  await page.hover('#link');
  assert.deepEqual(await page.$eval('#link', (e) => [getComputedStyle(e).textDecorationLine, getComputedStyle(e).cursor]), ['none', 'default']);
  assert.equal(applied.length, 1);
  await ctx.close();
  const plain = await run('A11.link.undecorate', '#plain');
  assert.deepEqual(plain.applied, [], 'already undecorated: no-op');
  await plain.ctx.close();
});

test('A11.input.smallFont', async () => {
  const { page, ctx, applied } = await run('A11.input.smallFont', '#plainin');
  assert.equal(await page.$eval('#plainin', (e) => getComputedStyle(e).fontSize), '10.6667px');
  assert.equal(applied.length, 1);
  await ctx.close();
});

test('A11.text.vhFont', async () => {
  const { page, ctx, applied } = await run('A11.text.vhFont', '#para');
  const [fs, vh] = await page.$eval('#para', (e) => [parseFloat(getComputedStyle(e).fontSize), window.innerHeight]);
  assert.ok(Math.abs(fs - vh * 0.02) < 0.1);
  assert.equal(applied.length, 1);
  await ctx.close();
});

test('A11.link.noOutline removes the focus outline', async () => {
  const { page, ctx, applied } = await run('A11.link.noOutline', '#btn');
  await page.focus('#btn');
  await page.keyboard.press('Shift'); // focus-visible
  assert.equal(await page.$eval('#btn', (e) => getComputedStyle(e).outlineStyle), 'none');
  assert.equal(applied.length, 1);
  await ctx.close();
});

test('A11.text.blink', async () => {
  const { page, ctx, applied } = await run('A11.text.blink', '#para');
  assert.deepEqual(await page.$eval('#para', (e) => [getComputedStyle(e).animationName, getComputedStyle(e).animationIterationCount]), ['mlmt-a11y-blink', 'infinite']);
  assert.equal(applied.length, 1);
  await ctx.close();
});

test('A11.nav.reverseTab', async () => {
  const { page, ctx, applied } = await run('A11.nav.reverseTab', '#list');
  assert.deepEqual(await page.$$eval('#list a', (as) => as.map((a) => a.getAttribute('tabindex'))), ['3', '2', '1']);
  assert.equal(applied.length, 1);
  await page.locator('body').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement!.textContent), 'C');
  await ctx.close();
  const single = await run('A11.nav.reverseTab', '#single');
  assert.deepEqual(single.applied, []);
  await single.ctx.close();
  // links rendered later
  const late = await run('A11.nav.reverseTab', '#later');
  assert.deepEqual(late.applied, []);
  await late.page.evaluate(() => { document.getElementById('later')!.innerHTML = '<a href="/1">1</a><a href="/2">2</a>'; });
  await late.page.waitForTimeout(50);
  assert.deepEqual(await late.page.$$eval('#later a', (as) => as.map((a) => a.getAttribute('tabindex'))), ['2', '1']);
  assert.equal(late.applied.length, 1);
  await late.ctx.close();
});

test('A11.imgLink.unlabel', async () => {
  const { page, ctx, applied } = await run('A11.imgLink.unlabel', '#imglink');
  assert.equal(await page.getAttribute('#imglink', 'aria-label'), null);
  assert.equal(await page.getAttribute('#imglink', 'title'), null);
  assert.equal(await page.getAttribute('#imglink img', 'alt'), '');
  assert.equal(await page.getByRole('link', { name: 'Home' }).count(), 0);
  assert.equal(applied.length, 1);
  await ctx.close();
});

test('A11.click.toMousedown: mouse works, keyboard does not', async () => {
  const { page, ctx, applied } = await run('A11.click.toMousedown', '#btn');
  assert.equal(await page.getAttribute('#btn', 'onclick'), null);
  assert.ok(await page.getAttribute('#btn', 'onmousedown'));
  await page.click('#btn');
  assert.equal(await page.evaluate(() => (window as any).hits), 1);
  await page.evaluate(() => { (window as any).clicks = 0; document.getElementById('btn')!.addEventListener('click', () => (window as any).clicks++); });
  await page.focus('#btn');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => (window as any).hits), 1);
  assert.equal(await page.evaluate(() => (window as any).clicks), 0);
  assert.equal(applied.length, 1);
  await ctx.close();
});

test('A11.button.ariaMismatch', async () => {
  const { page, ctx, applied } = await run('A11.button.ariaMismatch', '#btn');
  assert.match((await page.getAttribute('#btn', 'aria-label'))!, /^[a-z0-9]{6}$/);
  assert.equal(await page.getByRole('button', { name: 'Save' }).count(), 0);
  assert.equal(applied.length, 1);
  await ctx.close();
});

test('A11.focus.blur', async () => {
  const { page, ctx, applied } = await run('A11.focus.blur', '#name');
  await page.focus('#name');
  assert.notEqual(await page.evaluate(() => document.activeElement!.id), 'name');
  assert.equal(applied.length, 1);
  await ctx.close();
});

test('A11.click.openWindow', async () => {
  const { page, ctx, applied } = await run('A11.click.openWindow', '#word');
  await trackOpen(page);
  await page.click('#word');
  assert.deepEqual(await opened(page), ['about:blank']);
  assert.equal(applied.length, 1);
  await ctx.close();
});

test('A11.blur.openWindow', async () => {
  const { page, ctx, applied } = await run('A11.blur.openWindow', '#name');
  await trackOpen(page);
  await page.focus('#name');
  assert.deepEqual(await opened(page), []);
  await page.focus('#plainin');
  assert.deepEqual(await opened(page), ['about:blank']);
  assert.equal(applied.length, 1);
  await ctx.close();
});

test('A11.input.autoSubmit', async () => {
  const { page, ctx, applied } = await run('A11.input.autoSubmit', '#plainin');
  await page.evaluate(() => { (window as any).submits = 0; document.getElementById('form')!.addEventListener('submit', (e) => { e.preventDefault(); (window as any).submits++; }); });
  await page.fill('#plainin', 'abc');
  await page.locator('#plainin').blur();
  assert.equal(await page.evaluate(() => (window as any).submits), 1);
  assert.equal(applied.length, 1);
  await ctx.close();
});

test('A11.select.openWindow (select and radio)', async () => {
  const { page, ctx, applied } = await run('A11.select.openWindow', '#sel');
  await trackOpen(page);
  await page.selectOption('#sel', '2');
  assert.deepEqual(await opened(page), ['about:blank']);
  assert.equal(applied.length, 1);
  await ctx.close();
  const radio = await run('A11.select.openWindow', '#r1');
  await trackOpen(radio.page);
  await radio.page.check('#r1');
  assert.deepEqual(await opened(radio.page), ['about:blank']);
  await radio.ctx.close();
});

test('A11.input.unname: for-label and placeholder', async () => {
  const { page, ctx, applied } = await run('A11.input.unname', '#email');
  assert.equal(await page.getAttribute('#email', 'placeholder'), null);
  assert.equal(await page.locator('label[for=email]').count(), 0);
  assert.equal(await page.getByLabel('Email').count(), 0);
  assert.deepEqual(applied, ['removed placeholder, 1 label(s)']);
  await ctx.close();
});

test('A11.input.unname: wrapping label keeps the control', async () => {
  const { page, ctx, applied } = await run('A11.input.unname', '#name');
  assert.equal(await page.locator('#name').count(), 1);
  assert.equal(await page.getByLabel('Name').count(), 0);
  assert.equal(applied.length, 1);
  await ctx.close();
  const none = await run('A11.input.unname', '#plainin');
  assert.deepEqual(none.applied, []);
  await none.ctx.close();
});

/* ------------------------------------------------------------- VPS (WebSee) */

const VPS_CASES: Array<[string, string]> = [
  ['VPS.color.change', '#box'],
  ['VPS.size.change', '#box'],
  ['VPS.position.change', '#box'],
  ['VPS.visibility.change', '#box'],
  ['VPS.text.change', '#box'],
  ['VPS.decoration.change', '#box'],
];

for (const [id, sel] of VPS_CASES) {
  test(`${id} seeds one effective property`, async () => {
    for (const seed of [1, 2, 3]) {
      const { page, ctx, applied } = await run(id, sel, { seed });
      assert.equal(applied.length, 1, `${id} seed ${seed}`);
      const [prop, value] = applied[0].split(/:(.*)/s);
      assert.ok(Object.keys(opById(id).defaults.properties as object).includes(prop), applied[0]);
      const inline = await page.$eval(sel, (e, p) => [(e as HTMLElement).style.getPropertyValue(p), (e as HTMLElement).style.getPropertyPriority(p)], prop);
      assert.equal(inline[1], 'important', applied[0]);
      if (!/color/.test(prop)) assert.equal(inline[0], value, applied[0]); // colours are serialised as rgb()
      if (id === 'VPS.visibility.change') assert.ok(!/display:none|visibility:hidden/.test(applied[0]));
      // deterministic per seed
      const again = await run(id, sel, { seed });
      assert.deepEqual(again.applied, applied);
      await again.ctx.close();
      await ctx.close();
    }
  });
}

test('VPS: no report when no candidate changes the rendering', async () => {
  // top/left on a static element have no effect
  const { page, ctx, applied } = await run('VPS.position.change', '#box', { params: { properties: { top: ['+50px'], left: ['-50px'] } } });
  assert.deepEqual(applied, []);
  assert.equal(await page.$eval('#box', (e) => (e as HTMLElement).style.top), '');
  await ctx.close();
  // a border colour without border is invisible; outline colour without outline too
  const c = await run('VPS.color.change', '#inl', { params: { properties: { 'border-color': ['red'], 'outline-color': ['red'] } } });
  assert.deepEqual(c.applied, []);
  await c.ctx.close();
});

test('VPS.size.change relative values', async () => {
  const { page, ctx, applied } = await run('VPS.size.change', '#box', { params: { properties: { width: ['+50%'] } } });
  assert.deepEqual(applied, ['width:150px']);
  assert.equal(await page.$eval('#box', (e) => (e as HTMLElement).offsetWidth), 152);
  await ctx.close();
});

test('VPS.htmlattr.change', async () => {
  const { page, ctx, applied } = await run('VPS.htmlattr.change', '#logo');
  assert.equal(applied.length, 1);
  assert.match(applied[0], /^(width|height|align)="/);
  await ctx.close();
  const input = await run('VPS.htmlattr.change', '#plainin', { params: { values: { size: ['+50%'] } } });
  assert.equal(await input.page.getAttribute('#plainin', 'size'), '30');
  assert.deepEqual(input.applied, ['size="30" (was "20")']);
  await input.ctx.close();
});
