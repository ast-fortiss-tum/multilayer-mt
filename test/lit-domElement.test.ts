import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { chromium, Browser, Page } from '@playwright/test';
import { mlmtDomMutator, DomMutationSpec } from '../src/browser/domMutator';
import { DOM_ELEMENT_OPERATORS } from '../src/operators/lit/domElement';
import type { DomOperatorDef } from '../src/operators/registry';
import type { ElementInfo } from '../src/types';

const ORIGIN = 'http://mlmt.test';
const HTML = `<!doctype html><html><head><script>window.hits=[];</script></head><body>
<nav id="nav"><a id="home" class="nav-link" href="/home">Home</a><a id="about" class="nav-link" href="/about">About</a><a id="about2" href="/about">About again</a><a id="ext" href="https://other.example/x">Ext</a><a id="hash" href="#top">Top</a></nav>
<main id="main">
<h1 id="title" class="headline" title="Main title">Welcome home</h1>
<p id="para">Some paragraph</p>
<span id="empty"></span>
<b id="b1">bold one</b><b id="b2">bold two</b>
<div id="box" class="card d-flex"><span id="c1">one</span><span id="c2">two</span>tail</div>
<div id="leaf">plain leaf</div>
<ul id="list"><li id="li1">first</li><li id="li2">second</li><li id="li3">third</li></ul>
<form id="form" action="/submit" method="get">
 <input type="hidden" id="tok" name="token" value="abc">
 <input id="ro" name="ro" readonly value="fixed">
 <input id="user" name="user" type="text" value="bob">
 <input id="chk" type="checkbox" name="chk">
 <select id="sel" name="sel"><option value="a">A</option><option value="b" selected>B</option></select>
 <button id="sub" type="submit" formmethod="get">Send</button>
</form>
</main>
</body></html>`;

/** Only buttons as click targets (no navigation). */
const BUTTONS = `<!doctype html><html><head><script>window.hits=[];</script></head><body>
<div id="leaf">plain leaf</div>
<button id="btn" class="btn" onclick="window.hits.push('btn')">Press</button>
<button id="other" onclick="window.hits.push('other')">Other</button>
<p id="para">text</p>
</body></html>`;

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

const def = (id: string) => {
  const d = DOM_ELEMENT_OPERATORS.find((o) => o.id === id) as DomOperatorDef | undefined;
  assert.ok(d, `operator ${id} defined`);
  return d!;
};

async function mutated(operator: string, selector: string, html = HTML, seed = 7): Promise<{ page: Page; applied: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const applied: string[] = [];
  await ctx.exposeBinding('__mlmtApplied', (_s, info: any) => {
    applied.push(info.detail);
  });
  await ctx.route(ORIGIN + '/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  const d = def(operator);
  const spec: DomMutationSpec = { operator, pageKey: '*', pageKeyQuery: 'all', selector, params: d.defaults, seed, scope: 'element' };
  await ctx.addInitScript({ content: `(${mlmtDomMutator.toString()})(${JSON.stringify(spec)}, ${d.apply!.toString()});` });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + '/page');
  await page.waitForTimeout(50);
  return { page, applied };
}

const attr = (p: Page, sel: string, a: string) => p.getAttribute(sel, a);
const count = (p: Page, sel: string) => p.locator(sel).count();
const text = async (p: Page, sel: string) => ((await p.textContent(sel)) || '').trim();
const done = (op: string) => `[data-mlmt-mutated="${op}"]`;

function info(o: Partial<ElementInfo> & { tag: string }, facts: Partial<ElementInfo['facts']> = {}): ElementInfo {
  return {
    selector: '#x',
    attrs: {},
    text: '',
    visibility: { inViewport: true, displayed: true, opaque: true, nonZeroSize: true },
    ...o,
    facts: {
      textNodeWords: 0, childElementCount: 0, inForm: false, formSelector: null, formControlCount: 0,
      hasImgDescendant: false, hasImgWithAlt: false, associatedLabel: false, implicitRole: null, ...facts,
    },
  } as ElementInfo;
}

test('all batch-A operators are defined with metadata', () => {
  const ids = [
    'DAT.attr.add', 'DAT.attr.delete', 'DAT.attr.modify', 'DAT.attr.suffix', 'DEH.click.add', 'DEH.click.replace',
    'DTR.node.duplicate', 'DTR.children.delete', 'DTR.node.move', 'DCT.text.insert', 'DCT.text.replace', 'DCT.text.suffix',
    'DCT.text.grow', 'DCT.text.shrink', 'DST.color.random', 'DST.position.random', 'DST.size.random', 'DTG.tag.rename',
    'WLR.href.replace', 'WLD.href.empty', 'WFR.action.replace', 'WTR.method.swap', 'WHR.hidden.replace', 'WHD.hidden.delete',
    'WOD.readonly.delete', 'WCL.class.add', 'WCL.class.delete', 'WCL.class.modify', 'GUI.widget.remove', 'GUI.widget.similar',
    'GUI.widget.different', 'GUI.listener.double', 'GUI.widget.swap', 'GUI.widget.toEdge', 'GUI.widget.overlap', 'GUI.widget.retype',
  ];
  assert.deepEqual(DOM_ELEMENT_OPERATORS.map((o) => o.id).sort(), [...ids].sort());
  for (const o of DOM_ELEMENT_OPERATORS as DomOperatorDef[]) {
    assert.equal(o.layer, 'dom');
    assert.equal(o.scope, 'element');
    assert.equal(o.family, o.id.split('.')[0]);
    assert.ok(o.intent && o.refs!.length && o.aliases!.length, o.id);
    assert.equal(typeof o.apply, 'function');
    assert.match(o.apply!.toString(), /^function\b/, `${o.id} apply serialises as a function expression`);
  }
});

/* --------------------------------------------------------------- DAT */

test('DAT.attr.add adds a missing candidate attribute', async () => {
  const { page, applied } = await mutated('DAT.attr.add', '#para');
  assert.equal(applied.length, 1);
  const cls = await attr(page, '#para', 'class');
  const name = await attr(page, '#para', 'name');
  assert.ok(cls !== null || name !== null, applied[0]);
  if (cls !== null) assert.ok(['nav-link', 'headline', 'card', 'd-flex'].includes(cls), cls);
  await page.context().close();
});

test('DAT.attr.add on a button without type changes its effective type', async () => {
  const html = `<!doctype html><body><form><button id="b" class="c" name="n" formaction="/x" formmethod="post">B</button></form></body>`;
  const { page, applied } = await mutated('DAT.attr.add', '#b', html);
  assert.equal(applied.length, 1);
  assert.equal(await page.evaluate(() => (document.getElementById('b') as HTMLButtonElement).type), 'button');
  await page.context().close();
});

test('DAT.attr.delete removes a present candidate attribute', async () => {
  const { page, applied } = await mutated('DAT.attr.delete', '#title');
  assert.equal(applied.length, 1);
  const el = page.locator(done('DAT.attr.delete'));
  const id = await el.getAttribute('id');
  const cls = await el.getAttribute('class');
  assert.ok((id === null) !== (cls === null), applied[0]);
  await page.context().close();
});

test('DAT.attr.delete: no-op removals are not reported', async () => {
  const html = `<!doctype html><body><input type="text" id="i"></body>`;
  assert.equal(def('DAT.attr.delete').applicable!(info({ tag: 'input', attrs: { type: 'text' } }), {}), false);
  // id is the only effective candidate
  const { page, applied } = await mutated('DAT.attr.delete', '#i', html);
  assert.deepEqual(applied, ['removed id="i"']);
  assert.equal(await page.locator('input').getAttribute('type'), 'text');
  await page.context().close();
});

test('DAT.attr.modify replaces a value with another token from the page', async () => {
  const { page, applied } = await mutated('DAT.attr.modify', '#title');
  assert.equal(applied.length, 1);
  const el = page.locator(done('DAT.attr.modify'));
  const id = await el.getAttribute('id');
  const cls = await el.getAttribute('class');
  assert.ok(id !== 'title' || cls !== 'headline', applied[0]);
  // same seed => same mutant
  const again = await mutated('DAT.attr.modify', '#title');
  assert.deepEqual(again.applied, applied);
  await page.context().close();
  await again.page.context().close();
});

test('DAT.attr.suffix appends Mut to id, class or title', async () => {
  const { page, applied } = await mutated('DAT.attr.suffix', '#title');
  assert.equal(applied.length, 1);
  const el = page.locator(done('DAT.attr.suffix'));
  const vals = [await el.getAttribute('id'), await el.getAttribute('class'), await el.getAttribute('title')];
  assert.equal(vals.filter((v) => v && v.endsWith('Mut')).length, 1, applied[0]);
  assert.equal(def('DAT.attr.suffix').applicable!(info({ tag: 'div', attrs: { name: 'x' } }), {}), false);
  await page.context().close();
});

/* --------------------------------------------------------------- DEH */

test('DEH.click.add wires a leaf to another element handler (reported on click)', async () => {
  const { page, applied } = await mutated('DEH.click.add', '#leaf', BUTTONS);
  assert.equal(applied.length, 0, 'not reported before the click');
  await page.click('#leaf');
  await page.waitForTimeout(20);
  const hits = await page.evaluate(() => (window as any).hits);
  assert.equal(hits.length, 1);
  assert.ok(['btn', 'other'].includes(hits[0]));
  assert.equal(applied.length, 1);
  assert.equal(def('DEH.click.add').applicable!(info({ tag: 'button' }, { isLeaf: true }), {}), false);
  assert.equal(def('DEH.click.add').applicable!(info({ tag: 'div' }, { isLeaf: false }), {}), false);
  assert.equal(def('DEH.click.add').applicable!(info({ tag: 'div' }), {}), true);
  await page.context().close();
});

test('DEH.click.replace runs another element handler instead', async () => {
  const { page, applied } = await mutated('DEH.click.replace', '#btn', BUTTONS);
  assert.equal(applied.length, 1);
  await page.click('#btn');
  await page.waitForTimeout(20);
  assert.deepEqual(await page.evaluate(() => (window as any).hits), ['other']);
  assert.equal(def('DEH.click.replace').applicable!(info({ tag: 'div' }), {}), false);
  assert.equal(def('DEH.click.replace').applicable!(info({ tag: 'div', attrs: { onclick: 'f()' } }), {}), true);
  await page.context().close();
});

/* --------------------------------------------------------------- DTR */

test('DTR.node.duplicate inserts a marked clone after the element', async () => {
  const { page, applied } = await mutated('DTR.node.duplicate', '#para');
  assert.equal(applied.length, 1);
  assert.equal(await count(page, '#para'), 2);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#para')[1].getAttribute('data-mlmt-mutated')), 'DTR.node.duplicate');
  await page.context().close();
});

test('DTR.children.delete removes child elements and keeps text', async () => {
  const { page, applied } = await mutated('DTR.children.delete', '#box');
  assert.deepEqual(applied, ['removed 2 child element(s)']);
  assert.equal(await page.evaluate(() => document.getElementById('box')!.childElementCount), 0);
  assert.equal(await text(page, '#box'), 'tail');
  await page.context().close();
});

test('DTR.node.move moves the element elsewhere (once, no cascade on positional selectors)', async () => {
  const { page, applied } = await mutated('DTR.node.move', '#list > li:nth-of-type(2)');
  assert.equal(applied.length, 1);
  assert.notEqual(await page.evaluate(() => document.getElementById('li2')!.parentElement!.id), 'list');
  assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#list > li')).map((l) => l.id)), ['li1', 'li3']);
  await page.context().close();
});

/* --------------------------------------------------------------- DCT */

test('DCT.text.insert fills an empty leaf with text from the page', async () => {
  const { page, applied } = await mutated('DCT.text.insert', '#empty');
  assert.equal(applied.length, 1);
  assert.notEqual(await text(page, '#empty'), '');
  assert.equal(def('DCT.text.insert').applicable!(info({ tag: 'span', text: 'x' }), {}), false);
  assert.equal(def('DCT.text.insert').applicable!(info({ tag: 'input' }), {}), false);
  await page.context().close();
});

test('DCT.text.replace shows another leaf text', async () => {
  const { page, applied } = await mutated('DCT.text.replace', '#para');
  assert.equal(applied.length, 1);
  const t = await text(page, '#para');
  assert.ok(t && t !== 'Some paragraph', t);
  await page.context().close();
});

test('DCT.text.suffix appends Mut', async () => {
  const { page } = await mutated('DCT.text.suffix', '#para');
  assert.equal(await text(page, '#para'), 'Some paragraphMut');
  assert.equal(def('DCT.text.suffix').applicable!(info({ tag: 'div', text: 'x' }), {}), false);
  await page.context().close();
});

test('DCT.text.grow repeats the text', async () => {
  const { page } = await mutated('DCT.text.grow', '#para');
  assert.equal(await text(page, '#para'), 'Some paragraph Some paragraph');
  await page.context().close();
});

test('DCT.text.shrink truncates the text to half', async () => {
  const { page } = await mutated('DCT.text.shrink', '#para');
  assert.equal(await text(page, '#para'), 'Some pa');
  assert.equal(def('DCT.text.shrink').applicable!(info({ tag: 'p', text: 'x' }), {}), false);
  await page.context().close();
});

/* --------------------------------------------------------------- DST */

test('DST.color.random changes the computed colour', async () => {
  const { page, applied } = await mutated('DST.color.random', '#para');
  assert.equal(applied.length, 1);
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById('para')!).color), 'rgb(0, 0, 0)');
  await page.context().close();
});

test('DST.position.random positions the element absolutely', async () => {
  const { page, applied } = await mutated('DST.position.random', '#para');
  assert.equal(applied.length, 1);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('para')!).position), 'absolute');
  assert.equal(def('DST.position.random').applicable!(info({ tag: 'p', visibility: { displayed: false } as any }), {}), false);
  await page.context().close();
});

test('DST.size.random resizes the element', async () => {
  const { page, applied } = await mutated('DST.size.random', '#para');
  assert.equal(applied.length, 1);
  const m = /width:(\d+)px; height:(\d+)px/.exec(applied[0])!;
  const box = await page.locator('#para').boundingBox();
  assert.equal(Math.round(box!.width), Number(m[1]));
  assert.equal(Math.round(box!.height), Number(m[2]));
  await page.context().close();
});

/* --------------------------------------------------------------- DTG */

test('DTG.tag.rename renames the tag keeping attributes and children', async () => {
  const { page, applied } = await mutated('DTG.tag.rename', '#title');
  assert.deepEqual(applied, ['<h1> → <h2>']);
  assert.equal(await page.evaluate(() => document.getElementById('title')!.tagName), 'H2');
  assert.equal(await attr(page, '#title', 'class'), 'headline');
  assert.equal(await text(page, '#title'), 'Welcome home');
  assert.equal(def('DTG.tag.rename').applicable!(info({ tag: 'li' }), {}), false);
  await page.context().close();
});

test('DTG.tag.rename does not cascade on positional selectors', async () => {
  const { page, applied } = await mutated('DTG.tag.rename', 'main > b:nth-of-type(1)');
  assert.equal(applied.length, 1);
  assert.equal(await page.evaluate(() => document.getElementById('b1')!.tagName), 'STRONG');
  assert.equal(await page.evaluate(() => document.getElementById('b2')!.tagName), 'B');
  await page.context().close();
});

/* ------------------------------------------------------------ webMuJava */

test('WLR.href.replace points the link to the most frequent other same-origin URL', async () => {
  const { page, applied } = await mutated('WLR.href.replace', '#home');
  assert.equal(applied.length, 1);
  assert.equal(await attr(page, '#home', 'href'), ORIGIN + '/about');
  // the most frequent one is the link itself: use the second
  const again = await mutated('WLR.href.replace', '#about');
  assert.equal(await attr(again.page, '#about', 'href'), ORIGIN + '/home');
  assert.equal(def('WLR.href.replace').applicable!(info({ tag: 'a', attrs: { href: '#x' } }), {}), false);
  await page.context().close();
  await again.page.context().close();
});

test('WLD.href.empty empties the href', async () => {
  const { page, applied } = await mutated('WLD.href.empty', '#home');
  assert.equal(applied.length, 1);
  assert.equal(await attr(page, '#home', 'href'), '');
  await page.context().close();
});

test('WFR.action.replace redirects the enclosing form', async () => {
  const { page, applied } = await mutated('WFR.action.replace', '#user');
  assert.equal(applied.length, 1);
  assert.equal(await attr(page, '#form', 'action'), ORIGIN + '/about');
  assert.equal(def('WFR.action.replace').applicable!(info({ tag: 'p' }), {}), false);
  await page.context().close();
});

test('WTR.method.swap swaps GET/POST on the form and its submitters', async () => {
  const { page, applied } = await mutated('WTR.method.swap', '#user');
  assert.equal(applied.length, 1);
  assert.equal(await attr(page, '#form', 'method'), 'post');
  assert.equal(await attr(page, '#sub', 'formmethod'), 'post');
  await page.context().close();
});

test('WHR.hidden.replace changes a hidden value', async () => {
  const { page, applied } = await mutated('WHR.hidden.replace', '#user');
  assert.equal(applied.length, 1);
  assert.notEqual(await page.inputValue('#tok'), 'abc');
  assert.equal(def('WHR.hidden.replace').applicable!(info({ tag: 'input' }, { inForm: true, formHiddenCount: 0 }), {}), false);
  assert.equal(def('WHR.hidden.replace').applicable!(info({ tag: 'input' }, { inForm: true }), {}), true);
  await page.context().close();
});

test('WHD.hidden.delete removes a hidden input', async () => {
  const { page, applied } = await mutated('WHD.hidden.delete', '#user');
  assert.equal(applied.length, 1);
  assert.equal(await count(page, '#tok'), 0);
  await page.context().close();
});

test('WOD.readonly.delete removes a read-only input', async () => {
  const { page, applied } = await mutated('WOD.readonly.delete', '#user');
  assert.equal(applied.length, 1);
  assert.equal(await count(page, '#ro'), 0);
  assert.equal(def('WOD.readonly.delete').applicable!(info({ tag: 'input' }, { inForm: true, formReadonlyCount: 0 }), {}), false);
  await page.context().close();
});

/* --------------------------------------------------------------- WCL */

test('WCL.class.add adds a class used elsewhere (framework-ish preferred)', async () => {
  const { page, applied } = await mutated('WCL.class.add', '#para');
  assert.equal(applied.length, 1);
  assert.equal(await attr(page, '#para', 'class'), 'd-flex');
  await page.context().close();
});

test('WCL.class.delete removes one class', async () => {
  const { page, applied } = await mutated('WCL.class.delete', '#box');
  assert.equal(applied.length, 1);
  const cls = (await attr(page, '#box', 'class'))!;
  assert.ok(cls === 'card' || cls === 'd-flex', cls);
  assert.equal(def('WCL.class.delete').applicable!(info({ tag: 'div', attrs: { class: ' ' } }), {}), false);
  await page.context().close();
});

test('WCL.class.modify replaces one class with a page class', async () => {
  const { page, applied } = await mutated('WCL.class.modify', '#box');
  assert.equal(applied.length, 1);
  const cls = (await attr(page, '#box', 'class'))!.split(' ');
  assert.equal(cls.length, 2);
  assert.equal(cls.filter((c) => c === 'card' || c === 'd-flex').length, 1);
  await page.context().close();
});

/* --------------------------------------------------------------- GUI */

test('GUI.widget.remove removes exactly the element (no cascade)', async () => {
  const { page, applied } = await mutated('GUI.widget.remove', '#list > li:nth-of-type(2)');
  assert.equal(applied.length, 1);
  assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#list > li')).map((l) => l.id)), ['li1', 'li3']);
  await page.context().close();
});

test('GUI.widget.similar inserts a similar clone', async () => {
  const { page, applied } = await mutated('GUI.widget.similar', '#btn', BUTTONS);
  assert.equal(applied.length, 1);
  assert.equal(await text(page, '#btn_similar'), 'PressMut');
  assert.equal(await page.evaluate(() => document.getElementById('btn')!.nextElementSibling!.id), 'btn_similar');
  await page.context().close();
});

test('GUI.widget.different inserts an unrelated button before', async () => {
  const { page, applied } = await mutated('GUI.widget.different', '#para');
  assert.equal(applied.length, 1);
  assert.equal(await page.evaluate(() => document.getElementById('para')!.previousElementSibling!.textContent), 'New widget');
  await page.context().close();
});

test('GUI.listener.double delivers a click twice (reported on click)', async () => {
  const { page, applied } = await mutated('GUI.listener.double', '#btn', BUTTONS);
  assert.equal(applied.length, 0);
  await page.click('#btn');
  await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => (window as any).hits), ['btn', 'btn']);
  assert.deepEqual(applied, ['click delivered twice']);
  await page.context().close();
});

test('GUI.widget.swap swaps with the next sibling (once)', async () => {
  const { page, applied } = await mutated('GUI.widget.swap', '#list > li:nth-of-type(1)');
  assert.equal(applied.length, 1);
  assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#list > li')).map((l) => l.id)), ['li2', 'li1', 'li3']);
  const last = await mutated('GUI.widget.swap', '#li3');
  assert.deepEqual(await last.page.evaluate(() => Array.from(document.querySelectorAll('#list > li')).map((l) => l.id)), ['li1', 'li3', 'li2']);
  await page.context().close();
  await last.page.context().close();
});

test('GUI.widget.toEdge moves the widget partially outside the viewport', async () => {
  const { page, applied } = await mutated('GUI.widget.toEdge', '#para');
  assert.equal(applied.length, 1);
  const box = (await page.locator('#para').boundingBox())!;
  assert.ok(box.x < 1000 && box.x + box.width > 1000, JSON.stringify(box));
  await page.context().close();
});

test('GUI.widget.overlap places the widget over its previous sibling', async () => {
  const { page, applied } = await mutated('GUI.widget.overlap', '#li2');
  assert.equal(applied.length, 1);
  const a = (await page.locator('#li1').boundingBox())!;
  const b = (await page.locator('#li2').boundingBox())!;
  assert.ok(Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1, JSON.stringify({ a, b }));
  const none = await mutated('GUI.widget.overlap', '#li1');
  assert.equal(none.applied.length, 0, 'no previous sibling: not applied');
  await page.context().close();
  await none.page.context().close();
});

test('GUI.widget.retype changes the widget kind', async () => {
  const cases: [string, (p: Page) => Promise<void>][] = [
    ['#sub', async (p) => {
      assert.equal(await p.evaluate(() => (document.getElementById('sub') as HTMLInputElement).type), 'text');
      assert.equal(await p.inputValue('#sub'), 'Send');
    }],
    ['#user', async (p) => {
      assert.equal(await p.evaluate(() => document.getElementById('user')!.tagName), 'TEXTAREA');
      assert.equal(await p.inputValue('#user'), 'bob');
    }],
    ['#sel', async (p) => {
      assert.equal(await p.evaluate(() => document.getElementById('sel')!.tagName), 'INPUT');
      assert.equal(await p.inputValue('#sel'), 'b');
    }],
    ['#chk', async (p) => assert.equal(await attr(p, '#chk', 'type'), 'radio')],
    ['#home', async (p) => {
      assert.equal(await p.evaluate(() => document.getElementById('home')!.tagName), 'BUTTON');
      assert.equal(await attr(p, '#home', 'href'), null);
      assert.equal(await text(p, '#home'), 'Home');
    }],
  ];
  for (const [sel, check] of cases) {
    const { page, applied } = await mutated('GUI.widget.retype', sel);
    assert.equal(applied.length, 1, sel);
    await check(page);
    await page.context().close();
  }
  const ap = def('GUI.widget.retype').applicable!;
  assert.equal(ap(info({ tag: 'input', attrs: { type: 'hidden' } }), {}), false);
  assert.equal(ap(info({ tag: 'input' }), {}), true);
  assert.equal(ap(info({ tag: 'div' }), {}), false);
});
