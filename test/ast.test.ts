import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { findSites, generalizeSelector, mutateSource, specializeSelector } from '../src/operators/test/astMutator';

const SRC = `import { test, expect } from '@playwright/test';
test('login', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#login-btn');
  await page.fill('#email', 'a@b.c');
  await page.click('#login-btn');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.msg')).toHaveText('Welcome');
  await expect(page.locator('.list')).toContainText('x');
  await expect(page.locator('.err')).not.toBeVisible();
  expect(1 + 1).toEqual(2);
  await expect(page).toHaveScreenshot('home.png', { maxDiffPixels: 100 });
});
`;

function compiles(src: string): boolean {
  const out = ts.transpileModule(src, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.CommonJS } });
  return (out.diagnostics || []).length === 0;
}

const mutate = (op: string, site = 0, params: Record<string, unknown> = {}) => mutateSource(op, 'a.spec.ts', SRC, site, params);

test('TWR removes explicit waits', () => {
  assert.equal(findSites('TWR.wait.remove', 'a.spec.ts', SRC).length, 1);
  const m = mutate('TWR.wait.remove');
  assert.ok(!m.includes("waitForSelector('#login-btn')"));
  assert.ok(compiles(m));
});

test('TWA inserts waitForTimeout(1000) before actions', () => {
  const sites = findSites('TWA.wait.add', 'a.spec.ts', SRC);
  assert.equal(sites.length, 3); // fill, click, getByRole().click
  const m = mutate('TWA.wait.add');
  assert.match(m, /await page\.waitForTimeout\(1000\);\n\s+await page\.fill/);
  assert.ok(compiles(m));
});

test('AOL loosens and AOT tightens matchers', () => {
  const loosened = mutate('AOL.assert.loosen', 0, { matcherMap: { toHaveText: 'toContainText', toEqual: 'toContain' } });
  assert.match(loosened, /\.toContainText\('Welcome'\)/);
  const tightened = mutate('AOT.assert.tighten', 0, { matcherMap: { toContainText: 'toHaveText' } });
  assert.match(tightened, /locator\('\.list'\)\)\.toHaveText\('x'\)/);
});

test('AOF toggles .not', () => {
  const sites = findSites('AOF.assert.flip', 'a.spec.ts', SRC);
  assert.equal(sites.length, 5);
  assert.match(mutate('AOF.assert.flip', 0), /expect\(page\.locator\('\.msg'\)\)\.not\.toHaveText/);
  assert.match(mutate('AOF.assert.flip', 2), /expect\(page\.locator\('\.err'\)\)\.toBeVisible\(\)/);
});

test('AOV removes visual tolerance', () => {
  const m = mutate('AOV.visual.tolerance', 0, { maxDiffPixels: 0, threshold: 0 });
  assert.match(m, /toHaveScreenshot\('home\.png', \{ maxDiffPixels: 0, threshold: 0 \}\)/);
  assert.ok(compiles(m));
});

test('SOG / SOS selector rewrites', () => {
  assert.equal(generalizeSelector('button#save'), 'button');
  assert.equal(generalizeSelector('#login-btn'), '[id]');
  assert.equal(generalizeSelector('.btn.primary'), '.btn');
  assert.equal(generalizeSelector('form > button'), 'button');
  assert.equal(generalizeSelector('input[name="q"]'), 'input');
  assert.equal(generalizeSelector('text=Login'), null);
  assert.equal(specializeSelector('.btn'), '.btn:nth-child(3)');
  assert.equal(specializeSelector('li:nth-child(2)'), null);
  const g = mutate('SOG.selector.generalize', 3);
  assert.match(g, /getByRole\('button'\)\.click/);
  const s = mutate('SOS.selector.specialize', 0, { index: 3 });
  assert.match(s, /waitForSelector\('#login-btn:nth-child\(3\)'\)/);
});

test('mutated sources keep line numbers', () => {
  for (const op of ['TWR.wait.remove', 'AOL.assert.loosen', 'AOF.assert.flip', 'SOG.selector.generalize']) {
    const m = mutate(op, 0, { matcherMap: { toHaveText: 'toContainText' } });
    const idx = (s: string) => s.split('\n').findIndex((l) => l.includes("page.goto('/')"));
    assert.equal(idx(m), idx(SRC), op);
  }
});

test('SOG / SOS never treat a value, key or event name as a selector', () => {
  const src = `import { test } from '@playwright/test';
test('t', async ({ page }) => {
  const loc = page.locator('#name');
  await loc.fill('Real Name 001');
  await loc.type('a.b.c');
  await loc.press('Enter');
  await loc.pressSequentially('#hash.value');
  await loc.selectOption('red.green');
  await loc.getAttribute('data-x.y');
  await loc.dispatchEvent('click');
  await page.keyboard.press('Control.A');
  await page.fill('#legacy', 'plain value');
  await page.press('#legacy', 'Enter');
  await page.getByLabel('Name').fill('x');
});
`;
  for (const op of ['SOG.selector.generalize', 'SOS.selector.specialize']) {
    const sites = findSites(op, 't.spec.ts', src);
    const text = sites.map((s) => s.snippet).join('\n');
    for (const bad of ['Real Name 001', 'a.b.c', "'Enter')", '#hash.value', 'red.green', 'data-x.y', "'click'", 'Control.A', 'plain value']) {
      // the only legal sites are the selector arguments (#name, #legacy twice)
      assert.ok(!sites.some((s) => s.edits.some((e) => src.slice(e.start, e.end).includes(bad.replace(/'/g, '')))), `${op} mutates ${bad}`);
    }
    assert.ok(sites.length >= 1, `${op} lost its legitimate sites`);
    assert.ok(text.includes('#name') || text.includes('#legacy'), op);
  }
});

test('literal rewriting keeps template literals and escapes valid', () => {
  const src = 'import { test } from "@playwright/test";\ntest("t", async ({ page }) => {\n  await page.locator(`#a.b`).click();\n  await page.locator(\'#q\').click();\n});\n';
  const sf = ts.createSourceFile('t.spec.ts', src, ts.ScriptTarget.Latest, true);
  const { replaceLiteral } = require('../src/operators/test/astUtil');
  const lits: (ts.StringLiteral | ts.NoSubstitutionTemplateLiteral)[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) lits.push(n);
    n.forEachChild(walk);
  };
  walk(sf);
  for (const lit of lits.filter((l) => l.text.startsWith('#'))) {
    for (const value of ['has `tick` and ${x} and \\ back', "it's \"quoted\"\nnew line"]) {
      const e = replaceLiteral(sf, lit, value);
      const out = src.slice(0, e.start) + e.text + src.slice(e.end);
      const diags = (ts.createSourceFile('x.ts', out, ts.ScriptTarget.Latest, true) as any).parseDiagnostics;
      assert.equal(diags.length, 0, `invalid TS for ${JSON.stringify(value)}: ${out}`);
    }
  }
});
