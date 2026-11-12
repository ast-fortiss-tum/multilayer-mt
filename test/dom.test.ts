import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { chromium, Browser, Page } from '@playwright/test';
import { mlmtDomMutator, DomMutationSpec } from '../src/browser/domMutator';
import { DOM_OPERATORS } from '../src/operators/catalog';
import { installResourceFailure } from '../src/operators/network/runtime';

const URL_ = 'http://mlmt.test/page';
const HTML = `<!doctype html><html><head><link rel="stylesheet" href="/s.css"><script src="/a.js"></script></head><body>
<header role="banner"><nav><a id="link" href="/login" routerlink="/dashboard">Go to login</a></nav></header>
<main>
<h1 id="title">Welcome home</h1>
<div id="parent"><button id="btn" role="button" aria-label="Close" aria-describedby="help">Login Success</button></div>
<p id="help">help text</p>
<img id="logo" src="/logo.png" alt="Logo">
<form id="form">
  <label for="email">Email</label>
  <input id="email" type="email" placeholder="Email" aria-labelledby="x" pattern="[0-9]{3}" min="1" max="10" maxlength="20">
  <input id="name" type="text" required>
  <button id="submit" type="submit">Send</button>
</form>
<div id="list"><span>a</span><span>b</span></div>
</main>
<footer>footer</footer>
</body></html>`;

let browser: Browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

async function mutatedPage(operator: string, selector?: string, resourceUrl?: string): Promise<{ page: Page; applied: string[] }> {
  const ctx = await browser.newContext();
  const applied: string[] = [];
  await ctx.exposeBinding('__mlmtApplied', (_s, info: any) => { applied.push(info.detail); });
  await ctx.route('http://mlmt.test/**', (route) => {
    const u = route.request().url();
    if (u.endsWith('/page')) return route.fulfill({ contentType: 'text/html', body: HTML });
    if (u.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: 'body{color:red}' });
    if (u.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: 'window.__scriptLoaded=true' });
    return route.fulfill({ status: 404, body: '' });
  });
  const op = DOM_OPERATORS.find((o) => o.id === operator)!;
  const spec: DomMutationSpec = { operator, pageKey: URL_, pageKeyQuery: 'all', selector, resourceUrl, params: op.defaults, seed: 7 };
  await ctx.addInitScript({ content: `(${mlmtDomMutator.toString()})(${JSON.stringify(spec)});` });
  if (operator.startsWith('SFM.')) {
    // as in the runtime fixture: the resource also fails at the network boundary
    await installResourceFailure(ctx, resourceUrl, operator === 'SFM.script.fail' ? 'script' : 'stylesheet', (d) => applied.push(d));
  }
  const page = await ctx.newPage();
  await page.goto(URL_);
  await page.waitForTimeout(50);
  return { page, applied };
}

const attr = (p: Page, sel: string, a: string) => p.getAttribute(sel, a);

const CASES: Record<string, [string | undefined, (p: Page) => Promise<void>]> = {
  'AAM.required.add': ['#email', async (p) => assert.equal(await attr(p, '#email', 'required'), '')],
  'AAM.placeholder.remove': ['#email', async (p) => assert.equal(await attr(p, '#email', 'placeholder'), null)],
  'AAM.inputType.swap': ['#email', async (p) => assert.equal(await attr(p, '#email', 'type'), 'text')],
  'AAM.ariaLabel.remove': ['#btn', async (p) => assert.equal(await attr(p, '#btn', 'aria-label'), null)],
  'AMM.href.null': ['#link', async (p) => assert.equal(await attr(p, '#link', 'href'), '#')],
  'CDM.text.delete': ['#title', async (p) => assert.equal(await p.textContent('#title'), '')],
  'CDM.text.shuffle': ['#btn', async (p) => assert.equal(await p.textContent('#btn'), 'Success Login')],
  'CDM.text.leet': ['#title', async (p) => assert.notEqual(await p.textContent('#title'), 'Welcome home')],
  'CDM.input.prependWhitespace': ['#name', async (p) => {
    await p.fill('#name', 'admin');
    await p.locator('#name').blur();
    assert.equal(await p.inputValue('#name'), ' admin ');
  }],
  'EHDM.click.remove': ['#btn', async (p) => {
    // a listener registered by the page before the mutation must be gone
    assert.equal(await p.getAttribute('#btn', 'data-mlmt-mutated'), 'EHDM.click.remove');
  }],
  'EVD.click.stopPropagation': ['#btn', async (p) => {
    await p.evaluate(() => {
      (window as any).hits = [];
      document.getElementById('parent')!.addEventListener('click', () => (window as any).hits.push('parent'));
      document.getElementById('btn')!.addEventListener('click', () => (window as any).hits.push('target'));
    });
    await p.click('#btn');
    assert.deepEqual(await p.evaluate(() => (window as any).hits), ['target']);
  }],
  'EVD.click.delay': ['#btn', async (p) => {
    await p.evaluate(() => { (window as any).clicked = 0; document.getElementById('btn')!.addEventListener('click', () => (window as any).clicked++); });
    await p.click('#btn');
    assert.equal(await p.evaluate(() => (window as any).clicked), 0);
    await p.waitForTimeout(900);
    assert.equal(await p.evaluate(() => (window as any).clicked), 1);
  }],
  'EVD.submit.delay': ['#form', async (p) => {
    await p.evaluate(() => { (window as any).submits = 0; document.getElementById('form')!.addEventListener('submit', (e) => { e.preventDefault(); (window as any).submits++; }); });
    await p.fill('#name', 'x');
    await p.click('#submit');
    assert.equal(await p.evaluate(() => (window as any).submits), 0);
    await p.waitForTimeout(900);
    assert.equal(await p.evaluate(() => (window as any).submits), 1);
  }],
  'SVM.visibility.hide': ['#btn', async (p) => assert.equal(await p.isVisible('#btn'), false)],
  'SVM.display.none': ['#btn', async (p) => assert.equal(await p.isVisible('#btn'), false)],
  'SVM.opacity.dim': ['#btn', async (p) => assert.equal(await p.$eval('#btn', (e) => getComputedStyle(e).opacity), '0.2')],
  'SVM.force.scroll': ['#list', async (p) => assert.equal(await p.$eval('#list', (e) => getComputedStyle(e).overflow), 'auto')],
  'TIM.insert.ghostDiv': ['#list', async (p) => assert.equal(await p.$eval('#list', (e) => e.firstElementChild!.className), 'mlmt-ghost')],
  'TIM.node.removeSafe': [undefined, async (p) => {
    assert.equal(await p.$('footer'), null);
    assert.equal(await p.$('header'), null);
  }],
  'TIM.wrap.div': ['#btn', async (p) => assert.equal(await p.$('#parent > #btn'), null)],
  'TIM.form.reorderFields': ['#form', async (p) => assert.equal(await p.$eval('#form', (f) => f.querySelector('input')!.id), 'name')],
  'FVM.required.toggle': ['#name', async (p) => assert.equal(await attr(p, '#name', 'required'), null)],
  'PVM.pattern.break': ['#email', async (p) => assert.equal(await attr(p, '#email', 'pattern'), '[0-9]{2}')],
  'FVM.minmax.remove': ['#email', async (p) => {
    for (const a of ['min', 'max', 'maxlength']) assert.equal(await attr(p, '#email', a), null);
  }],
  'ATD.alt.delete': ['#logo', async (p) => assert.equal(await attr(p, '#logo', 'alt'), null)],
  'ARM.role.modify': ['#btn', async (p) => assert.equal(await attr(p, '#btn', 'role'), 'link')],
  'LUM.label.unlink': ['#email', async (p) => assert.equal(await attr(p, 'label', 'for'), 'email__broken')],
  'ARM.describedby.remove': ['#btn', async (p) => assert.equal(await attr(p, '#btn', 'aria-describedby'), null)],
  'BSM.img.break': ['#logo', async (p) => assert.equal(await attr(p, '#logo', 'src'), '/logo_404.png')],
  'SFM.script.fail': ['http://mlmt.test/a.js', async (p) => assert.equal(await p.evaluate(() => (window as any).__scriptLoaded), undefined)],
  'RLB.router.break': ['#link', async (p) => {
    assert.equal(await attr(p, '#link', 'routerlink'), '/404-not-found');
    assert.equal(await attr(p, '#link', 'href'), '/404-not-found');
  }],
  'SFM.stylesheet.fail': [undefined, async (p) => assert.match((await attr(p, 'link', 'href'))!, /\.404\.css$/)],
};

test('a browser test case exists for each of the 32 DOM operators', () => {
  assert.deepEqual(Object.keys(CASES).sort(), DOM_OPERATORS.map((o) => o.id).sort());
});

for (const [op, [selector, check]] of Object.entries(CASES)) {
  test(`DOM operator ${op}`, async () => {
    const isResource = op.startsWith('SFM.');
    const { page, applied } = await mutatedPage(op, isResource ? undefined : selector, isResource ? selector : undefined);
    try {
      await check(page);
      assert.ok(applied.length > 0, 'mutation reported as applied');
    } finally {
      await page.context().close();
    }
  });
}

test('mutations are scoped to their page', async () => {
  const ctx = await browser.newContext();
  await ctx.route('http://mlmt.test/**', (r) => r.fulfill({ contentType: 'text/html', body: HTML }));
  const spec: DomMutationSpec = { operator: 'SVM.display.none', pageKey: 'http://mlmt.test/other', pageKeyQuery: 'all', selector: '#btn', params: {}, seed: 1 };
  await ctx.addInitScript({ content: `(${mlmtDomMutator.toString()})(${JSON.stringify(spec)});` });
  const page = await ctx.newPage();
  await page.goto(URL_);
  assert.equal(await page.isVisible('#btn'), true);
  await ctx.close();
});
