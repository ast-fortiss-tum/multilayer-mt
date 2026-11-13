import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { TEST_LIT_OPERATORS } from '../src/operators/lit/testScript';
import type { TestOperatorDef, TestSite } from '../src/operators/registry';
import { findSites as registryFindSites, mutateSource } from '../src/operators/test/astMutator';

const ROOT = path.resolve(__dirname, '..', '..');

const IDS = [
  'TST.step.remove', 'TST.step.swap', 'TST.step.duplicate', 'TST.step.addBack', 'TST.step.refill',
  'TDT.input.change', 'TDT.string.amplify', 'TDT.number.amplify', 'TDT.bool.negate', 'TDT.check.toggle', 'TDT.select.change', 'TDT.input.empty',
  'TOR.closeTo.add', 'TOR.closeTo.tighten', 'TOR.closeTo.loosen', 'TOR.closeTo.remove', 'TOR.bool.swap', 'TOR.expect.failure', 'TOR.assert.oneShot',
  'TTO.timeout.decrease', 'TTO.timeout.increase', 'TTO.timeout.remove',
  'TWS.wait.shrink', 'TWS.wait.zero',
  'TDG.dialog.swap', 'TDG.handler.remove',
  'TEV.click.toHover', 'TEV.click.toDblclick',
  'TLC.css.idClassSwap', 'TLC.id.mutate', 'TLC.nth.shift', 'TLC.name.mutate',
  'TSS.cookies.clear',
];

const SAMPLE = `import { test, expect } from '@playwright/test';

test.describe('suite', () => {
  test.setTimeout(30000);
  test('form', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept('yes'));
    page.once('dialog', async (d) => { await d.dismiss(); });
    await page.goto('/form');
    await page.fill('#email', 'alice@example.com');
    await page.locator('#age').fill('42');
    await page.getByLabel('Name').fill(name);
    await page.locator('input.city').type('Rome', { delay: 10 });
    await page.locator('#search').press('Enter');
    await page.keyboard.press('Tab');
    await page.check('#agree');
    await page.locator('#news').uncheck();
    await page.locator('#vip').setChecked(true);
    await page.selectOption('#country', 'IT');
    await page.locator('[id="submit"]').click({ force: true, clickCount: 1, timeout: 5000 });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByTestId('save-btn').click();
    await page.locator('li').nth(2).click();
    await page.locator('.item').first().hover();
    await page.mouse.click(10, 20);
    await page.waitForTimeout(1000);
    await page.locator('div.panel #inner').waitFor({ timeout: 2000 });
    const dialog = await page.waitForEvent('dialog');
    await dialog.accept();
    await expect(page.locator('#msg')).toBeVisible();
    await expect(page.locator('#err')).not.toBeHidden({ timeout: 3000 });
    await expect(page.locator('#go')).toBeEnabled();
    await expect(page.locator('#agree')).toBeChecked();
    await expect(page.locator('#title')).toHaveText('Hello   world');
    await expect(page.locator('#body')).toContainText(/welcome/i, { useInnerText: true });
    await expect(page.locator('#age')).toHaveValue('42');
    await expect(page.locator('li')).toHaveCount(3);
    await expect(page).toHaveURL('/done');
    await expect(page).toHaveURL(/done/);
    expect(total).toBe(42);
    expect(ratio).toBeCloseTo(0.3);
    expect(ratio).toBeCloseTo(0.33, 2);
    expect(flag).toBeTruthy();
  });
});

test('fails', async ({ page }) => { await page.goto(\`/x\`); });
`;

/** Edge cases for literal re-quoting and odd shapes. */
const EDGE = `import { test, expect } from '@playwright/test';
test(\`edge\`, async ({ page, context }) => {
  await page.fill('#q', 'it\\'s "quoted" \\\\ back\\nslash');
  await page.locator(\`#tpl\`).fill(\`a\${'$'}{b}\`);
  await page.locator("#dq").fill("double 'q'");
  await page.getByPlaceholder(\`Search \${term}\`).fill(term);
  await page.getByRole('link', { name }).click();
  await page.locator('css=#main .nav').click({ button: 'right' });
  await page.locator('id=login').click();
  await page.locator('text=Hello').click();
  await page.locator('//div[@id="x"]').click();
  await page.locator('[data-testid=foo]').click({ timeout: 100 });
  await page.waitForTimeout(ms);
  await page.locator('li').nth(i).click();
  context.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(15000);
  await page.click('#a', { timeout: 10, noWaitAfter: true });
  await expect.soft(page.locator('#s')).toBeVisible();
  await expect.poll(async () => 1).toBe(1);
  expect(x).toBe(-1.5);
  await expect(page.locator('#w')).toHaveText(['a', 'b']);
  await expect(page.locator('#v')).toBeVisible({ visible: false });
  await expect(page).toHaveURL('https://example.org/');
  switch (mode) {
    case 1:
      await page.goto('/one');
      await page.goto('/two');
      break;
  }
});
`;

function sourceFiles(): Record<string, string> {
  const out: Record<string, string> = { 'sample.spec.ts': SAMPLE, 'edge.spec.ts': EDGE };
  for (const dir of ['experiments/subjects/mediawiki/tests', 'examples/todo-app/tests']) {
    const abs = path.join(ROOT, dir);
    for (const f of fs.readdirSync(abs)) if (f.endsWith('.spec.ts')) out[`${dir}/${f}`] = fs.readFileSync(path.join(abs, f), 'utf8');
  }
  return out;
}

const OPS = new Map(TEST_LIT_OPERATORS.map((o) => [o.id, o as TestOperatorDef]));

function parse(source: string, name = 'x.spec.ts'): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function syntaxErrors(source: string): string[] {
  const sf = parse(source) as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] };
  return (sf.parseDiagnostics || []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

function sitesOf(id: string, source: string, params: Record<string, unknown> = {}): TestSite[] {
  const op = OPS.get(id)!;
  return op.findSites!(parse(source), { ...op.defaults, ...params }, ts);
}

function apply(source: string, s: TestSite): string {
  let out = source;
  for (const e of [...s.edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function mutants(id: string, source = SAMPLE, params: Record<string, unknown> = {}): string[] {
  return sitesOf(id, source, params).map((s) => apply(source, s));
}

function has(id: string, needle: string | RegExp, source = SAMPLE): void {
  const ms = mutants(id, source);
  const ok = ms.some((m) => (typeof needle === 'string' ? m.includes(needle) : needle.test(m)));
  assert.ok(ok, `${id}: no mutant contains ${needle}\n--- sites:\n${sitesOf(id, source).map((s) => s.description).join('\n')}`);
}

/** No site adds or removes an occurrence of `needle`. */
function hasNot(id: string, needle: string | RegExp, source = SAMPLE): void {
  const re = typeof needle === 'string' ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : new RegExp(needle.source, 'g');
  const count = (t: string) => (t.match(re) || []).length;
  for (const m of mutants(id, source)) assert.equal(count(m), count(source), `${id}: unexpected change of ${needle}`);
}

/* ---------------------------------------------------------------- shape */

test('Batch E: every planned operator is defined with metadata', () => {
  assert.deepEqual([...OPS.keys()].sort(), [...IDS].sort());
  for (const o of TEST_LIT_OPERATORS) {
    assert.equal(o.layer, 'test');
    assert.equal(o.family, o.id.split('.')[0]);
    assert.ok(o.intent && o.intent.length > 10, o.id);
    assert.ok(o.refs && o.refs.length, o.id);
    assert.ok(o.aliases && o.aliases.length, o.id);
    assert.equal(typeof (o as TestOperatorDef).findSites, 'function');
  }
});

test('every site of every operator yields a syntactically valid, changed file', () => {
  const files = sourceFiles();
  let total = 0;
  for (const id of IDS) {
    for (const [name, src] of Object.entries(files)) {
      const sites = sitesOf(id, src);
      let last = -1;
      for (const [i, s] of sites.entries()) {
        total++;
        assert.ok(s.edits.length > 0, `${id} ${name}#${i}: no edits`);
        assert.ok(s.line >= last, `${id} ${name}: sites not in source order`);
        last = s.line;
        const sorted = [...s.edits].sort((a, b) => a.start - b.start);
        for (let k = 1; k < sorted.length; k++) assert.ok(sorted[k].start >= sorted[k - 1].end, `${id} ${name}#${i}: overlapping edits`);
        const out = apply(src, s);
        assert.notEqual(out, src, `${id} ${name}#${i}: no-op site (${s.description})`);
        const errs = syntaxErrors(out);
        assert.deepEqual(errs, [], `${id} ${name}#${i} (${s.description}) produced invalid TS:\n${out}`);
      }
    }
  }
  assert.ok(total > 500, `only ${total} sites`);
});

test('every operator has at least one site on the inline samples', () => {
  for (const id of IDS) assert.ok(sitesOf(id, SAMPLE).length + sitesOf(id, EDGE).length > 0, id);
});

test('site counts on the MediaWiki suite', () => {
  const files = Object.entries(sourceFiles()).filter(([f]) => f.includes('mediawiki'));
  assert.equal(files.length, 27);
  const rows = IDS.map((id) => [id, files.reduce((n, [, src]) => n + sitesOf(id, src).length, 0)] as const);
  console.log(rows.map(([id, n]) => `${id.padEnd(22)} ${n}`).join('\n'));
  // spot checks
  const count = (id: string) => rows.find((r) => r[0] === id)![1];
  assert.equal(count('TWS.wait.zero'), 1);
  assert.ok(count('TST.step.remove') > 100);
  assert.ok(count('TLC.nth.shift') > 5);
});

test('registry integration: findSites/mutateSource resolve literature test operators', () => {
  const sites = registryFindSites('TEV.click.toHover', 'a.spec.ts', SAMPLE);
  assert.equal(sites.length, sitesOf('TEV.click.toHover', SAMPLE).length);
  const m = mutateSource('TDT.check.toggle', 'a.spec.ts', SAMPLE, 0);
  assert.match(m, /await page\.uncheck\('#agree'\);/);
  assert.match(m, /MultilayerMT mutant: TDT\.check\.toggle/);
});

/* ------------------------------------------------------------ TST steps */

test('TST.step.remove / swap / duplicate', () => {
  has('TST.step.remove', /\/\* \[mlmt\] TST removed: goto\(\) \*\/\n    await page\.fill\('#email'/);
  has('TST.step.remove', "/* [mlmt] TST removed: press() */\n    await page.keyboard.press('Tab');");
  hasNot('TST.step.remove', '/* [mlmt] TST removed: toBeVisible');
  // page.on/expect/waitFor statements are not steps
  assert.equal(sitesOf('TST.step.remove', SAMPLE).length, 18);
  has('TST.step.swap', "await page.fill('#email', 'alice@example.com');\n    await page.goto('/form');");
  has('TST.step.swap', "await page.goto('/two');\n      await page.goto('/one');", EDGE);
  // waitForTimeout breaks the chain: hover() and mouse.click() swap, mouse.click() and waitForTimeout() do not
  hasNot('TST.step.swap', "await page.waitForTimeout(1000);\n    await page.mouse.click");
  has('TST.step.duplicate', "await page.goto('/form');\n    await page.goto('/form');");
});

test('TST.step.addBack and TST.step.refill', () => {
  has('TST.step.addBack', "click({ force: true, clickCount: 1, timeout: 5000 });\n    await page.goBack();\n    await page.locator('[id=\"submit\"]').click(");
  has('TST.step.refill', "await page.locator('#age').fill('42');\n    await page.fill('#email', 'alice@example.comMut');");
  has('TST.step.refill', "await page.getByLabel('Name').fill(name);\n    await page.locator('#age').fill('42Mut');");
  // identifier value -> template literal
  const mw = fs.readFileSync(path.join(ROOT, 'experiments/subjects/mediawiki/tests/01-create-user.spec.ts'), 'utf8');
  has('TST.step.refill', "await page.locator('#wpPassword2').fill(PASSWORD);\n  await page.locator('#wpName2').fill(`${user}Mut`);", mw);
  assert.equal(sitesOf('TST.step.refill', mw).length, 3);
});

/* -------------------------------------------------------- TDT test data */

test('TDT.input.change keeps the kind of value', () => {
  has('TDT.input.change', "page.fill('#email', 'mutant@example.org')");
  has('TDT.input.change', "fill('43')");
  has('TDT.input.change', /type\('(mutant|zebra|orbit|quux|lorem|delta|plum|vortex)', \{ delay: 10 \}\)/);
  hasNot('TDT.input.change', "fill('#email_"); // the selector is never changed
  assert.equal(sitesOf('TDT.input.change', SAMPLE).length, 3); // fill(name) is not a literal
  // quotes and escapes survive
  for (const m of mutants('TDT.input.change', EDGE)) assert.deepEqual(syntaxErrors(m), []);
});

test('TDT.string.amplify changes one char of one literal per site', () => {
  const sites = sitesOf('TDT.string.amplify', SAMPLE);
  // goto x2, fill x2 (2 literal args in page.fill) + fill('42'), type, press, keyboard.press, check, selectOption x2
  assert.equal(sites.length, 11);
  for (const s of sites) {
    assert.equal(s.edits.length, 1);
    const [, from, to] = s.description.match(/^"(.*)" -> "(.*)" \(/)!;
    assert.notEqual(from, to);
    assert.ok(Math.abs(from.length - to.length) <= 1);
  }
  // deterministic
  assert.deepEqual(sitesOf('TDT.string.amplify', SAMPLE), sites);
});

test('TDT.number.amplify: n+1, n-1, 0', () => {
  has('TDT.number.amplify', 'toHaveCount(4)');
  has('TDT.number.amplify', 'toHaveCount(2)');
  has('TDT.number.amplify', 'toHaveCount(0)');
  has('TDT.number.amplify', 'toBe(43)');
  has('TDT.number.amplify', 'toBeCloseTo(0.33, 3)');
  has('TDT.number.amplify', 'mouse.click(10, 19)');
  hasNot('TDT.number.amplify', 'nth(3)'); // nth is TLC.nth.shift
});

test('TDT.bool.negate / check.toggle / select.change / input.empty', () => {
  has('TDT.bool.negate', 'click({ force: false, clickCount: 1, timeout: 5000 })');
  has('TDT.bool.negate', "{ name: 'Save', exact: false }");
  has('TDT.bool.negate', 'setChecked(false)');
  assert.equal(sitesOf('TDT.bool.negate', SAMPLE).length, 3);
  has('TDT.check.toggle', "await page.uncheck('#agree');");
  has('TDT.check.toggle', "locator('#news').check();");
  has('TDT.select.change', "page.selectOption('#country', '')");
  has('TDT.input.empty', "page.fill('#email', '')");
  has('TDT.input.empty', "getByLabel('Name').fill('')");
  has('TDT.input.empty', 'locator("#dq").fill("")', EDGE);
  hasNot('TDT.input.empty', "type('')");
});

/* ------------------------------------------------------------- TOR oracles */

test('TOR.closeTo.*', () => {
  has('TOR.closeTo.add', 'expect(total).toBeCloseTo(42, 0);');
  has('TOR.closeTo.add', 'expect(x).toBeCloseTo(-1.5, 0);', EDGE);
  has('TOR.closeTo.tighten', 'toBeCloseTo(0.3, 3)');
  has('TOR.closeTo.tighten', 'toBeCloseTo(0.33, 3)');
  has('TOR.closeTo.loosen', 'toBeCloseTo(0.3, 1)');
  has('TOR.closeTo.loosen', 'toBeCloseTo(0.33, 1)');
  has('TOR.closeTo.remove', 'expect(ratio).toBe(0.3);');
  has('TOR.closeTo.remove', 'expect(ratio).toBe(0.33);');
});

test('TOR.bool.swap', () => {
  has('TOR.bool.swap', "expect(page.locator('#msg')).toBeHidden()");
  has('TOR.bool.swap', "expect(page.locator('#err')).not.toBeVisible({ timeout: 3000 })");
  has('TOR.bool.swap', "expect(page.locator('#go')).toBeDisabled()");
  has('TOR.bool.swap', "expect(page.locator('#agree')).not.toBeChecked()");
  has('TOR.bool.swap', 'expect(flag).toBeFalsy()');
  assert.equal(sitesOf('TOR.bool.swap', SAMPLE).length, 5);
});

test('TOR.expect.failure', () => {
  has('TOR.expect.failure', "test.fail('form', async");
  has('TOR.expect.failure', 'test.fail(\'fails\'');
  has('TOR.expect.failure', 'test.fail(`edge`', EDGE);
  hasNot('TOR.expect.failure', 'describe.fail');
  assert.equal(sitesOf('TOR.expect.failure', SAMPLE).length, 2);
});

test('TOR.assert.oneShot', () => {
  has('TOR.assert.oneShot', "await expect(await page.locator('#msg').isVisible()).toBe(true);");
  has('TOR.assert.oneShot', "await expect(await page.locator('#err').isHidden()).not.toBe(true);");
  has('TOR.assert.oneShot', "await expect(await page.locator('#go').isEnabled()).toBe(true);");
  has('TOR.assert.oneShot', "await expect(await page.locator('#agree').isChecked()).toBe(true);");
  has('TOR.assert.oneShot', "await expect(((await page.locator('#title').textContent()) ?? '').replace(/\\s+/g, ' ').trim()).toBe('Hello world');");
  has('TOR.assert.oneShot', "await expect((await page.locator('#body').innerText()).replace(/\\s+/g, ' ').trim()).toMatch(/welcome/i);");
  has('TOR.assert.oneShot', "await expect(await page.locator('#age').inputValue()).toBe('42');");
  has('TOR.assert.oneShot', "await expect(await page.locator('li').count()).toBe(3);");
  has('TOR.assert.oneShot', "await expect(page.url().endsWith('/done')).toBe(true);");
  has('TOR.assert.oneShot', 'await expect(page.url()).toMatch(/done/);');
  assert.equal(sitesOf('TOR.assert.oneShot', SAMPLE).length, 10);
  // soft kept; poll, arrays and state options skipped
  has('TOR.assert.oneShot', "await expect.soft(await page.locator('#s').isVisible()).toBe(true);", EDGE);
  has('TOR.assert.oneShot', "await expect(page.url()).toBe('https://example.org/');", EDGE);
  assert.equal(sitesOf('TOR.assert.oneShot', EDGE).length, 2);
});

/* ------------------------------------------------------------ TTO / TWS */

test('TTO.timeout.*', () => {
  has('TTO.timeout.decrease', 'test.setTimeout(3000);');
  has('TTO.timeout.decrease', 'clickCount: 1, timeout: 500 }');
  has('TTO.timeout.decrease', 'waitFor({ timeout: 200 })');
  has('TTO.timeout.decrease', 'not.toBeHidden({ timeout: 300 })');
  has('TTO.timeout.decrease', "click('#a', { timeout: 1, noWaitAfter: true })", EDGE);
  has('TTO.timeout.decrease', 'setDefaultNavigationTimeout(1500)', EDGE);
  hasNot('TTO.timeout.decrease', 'setDefaultTimeout(0)', EDGE); // 0 = no timeout
  assert.equal(sitesOf('TTO.timeout.decrease', SAMPLE).length, 4);
  has('TTO.timeout.increase', 'test.setTimeout(300000);');
  has('TTO.timeout.increase', 'waitFor({ timeout: 20000 })');
  has('TTO.timeout.remove', 'click({ force: true, clickCount: 1 })');
  has('TTO.timeout.remove', "page.locator('div.panel #inner').waitFor();");
  has('TTO.timeout.remove', "not.toBeHidden();");
  has('TTO.timeout.remove', "click('#a', { noWaitAfter: true })", EDGE);
  has('TTO.timeout.remove', "locator('[data-testid=foo]').click();", EDGE);
});

test('TWS.wait.shrink / zero', () => {
  has('TWS.wait.shrink', 'waitForTimeout(500)');
  has('TWS.wait.shrink', 'waitForTimeout((ms) / 2)', EDGE);
  has('TWS.wait.zero', 'waitForTimeout(0)');
  assert.equal(sitesOf('TWS.wait.zero', SAMPLE.replace('waitForTimeout(1000)', 'waitForTimeout(0)')).length, 0);
});

/* --------------------------------------------------------------- TDG */

test('TDG.dialog.swap / handler.remove', () => {
  has('TDG.dialog.swap', "page.on('dialog', (dialog) => dialog.dismiss());");
  has('TDG.dialog.swap', 'async (d) => { await d.accept(); }');
  has('TDG.dialog.swap', 'await dialog.dismiss();');
  assert.equal(sitesOf('TDG.dialog.swap', SAMPLE).length, 3);
  assert.equal(sitesOf('TDG.dialog.swap', 'await api.accept(); await form.dismiss();').length, 0);
  has('TDG.handler.remove', "/* [mlmt] TDG removed: on('dialog') handler */\n    page.once(");
  has('TDG.handler.remove', "/* [mlmt] TDG removed: once('dialog') handler */");
  assert.equal(sitesOf('TDG.handler.remove', SAMPLE).length, 2);
});

/* --------------------------------------------------------------- TEV */

test('TEV.click.toHover / toDblclick', () => {
  has('TEV.click.toHover', "locator('[id=\"submit\"]').hover({ force: true, timeout: 5000 })");
  has('TEV.click.toHover', "getByTestId('save-btn').hover();");
  has('TEV.click.toHover', "locator('css=#main .nav').hover();", EDGE);
  hasNot('TEV.click.toHover', 'mouse.hover');
  assert.equal(sitesOf('TEV.click.toHover', SAMPLE).length, 4);
  has('TEV.click.toDblclick', "dblclick({ force: true, timeout: 5000 })");
  has('TEV.click.toDblclick', 'page.mouse.dblclick(10, 20)');
  has('TEV.click.toDblclick', "locator('css=#main .nav').dblclick({ button: 'right' })", EDGE);
});

/* --------------------------------------------------------------- TLC */

test('TLC.css.idClassSwap', () => {
  has('TLC.css.idClassSwap', "page.fill('.email', 'alice@example.com')");
  has('TLC.css.idClassSwap', "locator('input#city')");
  has('TLC.css.idClassSwap', "locator('div#panel #inner')");
  has('TLC.css.idClassSwap', "locator('css=.main .nav')", EDGE);
  hasNot('TLC.css.idClassSwap', "press('.Enter')");
  hasNot('TLC.css.idClassSwap', 'text=Hello', EDGE);
  // value arguments are never treated as selectors
  assert.equal(sitesOf('TLC.css.idClassSwap', "await page.locator('#a').fill('#b');").length, 1);
});

test('TLC.id.mutate', () => {
  has('TLC.id.mutate', "page.fill('#email_mut'");
  has('TLC.id.mutate', `locator('[id="submit_mut"]')`);
  has('TLC.id.mutate', "getByTestId('save-btn_mut')");
  has('TLC.id.mutate', "locator('div.panel #inner_mut')");
  has('TLC.id.mutate', "locator('id=login_mut')", EDGE);
  has('TLC.id.mutate', "locator('[data-testid=foo_mut]')", EDGE);
  hasNot('TLC.id.mutate', "locator('input.city_mut')");
  hasNot('TLC.id.mutate', 'Enter_mut');
});

test('TLC.nth.shift / name.mutate', () => {
  has('TLC.nth.shift', "locator('li').nth(3)");
  has('TLC.nth.shift', "locator('.item').last().hover()");
  has('TLC.nth.shift', "nth((i) + 1)", EDGE);
  has('TLC.name.mutate', "getByLabel('NameMut')");
  has('TLC.name.mutate', "{ name: 'SaveMut', exact: true }");
  has('TLC.name.mutate', 'getByPlaceholder(`Search ${term}Mut`)', EDGE);
  has('TLC.name.mutate', "getByRole('link', { name: `${name}Mut` })", EDGE);
  const mw = fs.readFileSync(path.join(ROOT, 'experiments/subjects/mediawiki/tests/04-create-and-link-page.spec.ts'), 'utf8');
  if (mw.includes("{ name: title, exact: true }")) has('TLC.name.mutate', '{ name: `${title}Mut`, exact: true }', mw);
});

/* --------------------------------------------------------------- TSS */

test('TSS.cookies.clear', () => {
  has('TSS.cookies.clear', "await page.context().clearCookies();\n    await page.goto('/form');");
  has('TSS.cookies.clear', "await page.context().clearCookies();\n      await page.goto('/one');", EDGE);
  assert.equal(sitesOf('TSS.cookies.clear', SAMPLE).length, sitesOf('TST.step.remove', SAMPLE).length);
  assert.equal(sitesOf('TSS.cookies.clear', 'test("t", async () => { await first.locator("x").click(); });').length, 0);
});

/* ----------------------------------------------------- SOG regression */

test('SOG.selector.generalize never treats press()/keyboard key arguments as selectors', () => {
  const src = `import { test } from '@playwright/test';
test('t', async ({ page }) => {
  await page.locator('#searchInput').press('Enter');
  await page.locator('#q').press('Enter', { delay: 10 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('hello');
  await page.press('#legacy', 'Enter');
});
`;
  const sites = registryFindSites('SOG.selector.generalize', 'a.spec.ts', src);
  for (const s of sites) assert.ok(!/Enter|hello/.test(s.description), `key treated as selector: ${s.description}`);
  for (let i = 0; i < sites.length; i++) assert.ok(!mutateSource('SOG.selector.generalize', 'a.spec.ts', src, i).includes('press("*")'));
  const descs = sites.map((s) => s.description);
  assert.ok(descs.includes('selector "#searchInput" -> "[id]"'), descs.join('\n'));
  assert.ok(descs.includes('selector "#legacy" -> "[id]"'), descs.join('\n')); // page.press(selector, key) still mutated
  assert.equal(sites.length, 3);
});
