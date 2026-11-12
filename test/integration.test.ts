import { test, before, after, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { chromium, Browser } from '@playwright/test';
import {
  applyDomMutation, applyNetworkMutation, attachRecorder, buildPweModel, ConfigError, createSuiteTrace, listTestMutationSites,
  loadConfigAsync, mutateTestSource, OperatorRegistry, registry,
} from '../src/index';

const CLI = path.resolve(__dirname, '../src/cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmt-it-'));

/* ------------------------------------------------------------ fixtures */

const PAGE = `<!doctype html><html><body>
<h1 id="t">Hello world</h1>
<input id="q" placeholder="Search" title="tooltip">
<button id="go" onclick="fetch('/api/items').then(r => r.json()).then(d => { document.getElementById('out').textContent = d.items.map(i => i.name).join(','); document.getElementById('st').textContent = d.status; })">Go</button>
<p id="out"></p><p id="st"></p>
</body></html>`;

let server: http.Server;
let base = '';
let browser: Browser;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/items')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'OK', items: [{ name: 'a' }, { name: 'b' }] }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as any).port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const PLUGIN = `
module.exports = {
  name: 'it-plugin',
  operators: [
    { id: 'XAM.title.remove', layer: 'dom', category: 'Attribute Mutations', intent: 'remove tooltips',
      applicable: (el) => 'title' in el.attrs,
      apply(el) { if (!el.hasAttribute('title')) return null; el.removeAttribute('title'); return 'title removed'; } },
    { id: 'XPG.body.mark', layer: 'dom', scope: 'page',
      apply: (root) => { root.setAttribute('data-x', '1'); return 'marked'; } },
    { id: 'XNS.status.teapot', layer: 'network', defaults: { status: 418 },
      handle: async ({ route, params, applied }) => { applied('teapot'); await route.fulfill({ status: params.status, body: '{}' }); } },
    { id: 'XTO.goto.remove', layer: 'test',
      findSites: (sf, params, ts) => {
        const out = [];
        const visit = (n) => {
          if (ts.isExpressionStatement(n) && /\\.goto\\(/.test(n.getText(sf))) {
            out.push({ edits: [{ start: n.getStart(sf), end: n.end, text: '' }], line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, snippet: n.getText(sf), description: 'remove goto' });
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
        return out;
      } },
  ],
};`;

/* -------------------------------------------------------------- config */

describe('config', () => {
  test('object config with overrides and defaults', async () => {
    const c = await loadConfigAsync({ projectRoot: tmp, maxPwe: 4, network: { include: 'api' } }, { workers: 2 });
    assert.equal(c.maxPwe, 4);
    assert.equal(c.workers, 2);
    assert.deepEqual(c.network.resourceTypes, ['xhr', 'fetch', 'document']);
    assert.equal(c.abs.testDir, path.join(tmp, 'tests'));
  });

  test('validation reports every problem', async () => {
    await assert.rejects(loadConfigAsync({ projectRoot: tmp, workers: 0, layers: ['ui' as any], testSelection: 'x' as any }), (e: Error) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /workers/);
      assert.match(e.message, /layers/);
      assert.match(e.message, /testSelection/);
      return true;
    });
  });

  test('discovers mlmt.config.js (defineConfig style, function export)', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'cfg-'));
    fs.writeFileSync(path.join(dir, 'mlmt.config.js'), `module.exports = () => ({ app: 'disc', maxPwe: 16 });`);
    const c = await loadConfigAsync(undefined, {}, dir);
    assert.equal(c.app, 'disc');
    assert.equal(c.maxPwe, 16);
    assert.equal(c.abs.configFile, path.join(dir, 'mlmt.config.js'));
  });
});

/* ------------------------------------------------------- test-script API */

describe('test-script API', () => {
  const SRC = `import { test, expect } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
  await page.click('#go');
  await expect(page.locator('#out')).toHaveText('a,b');
});
`;
  test('listTestMutationSites + mutateTestSource', () => {
    const sites = listTestMutationSites(SRC);
    const ops = new Set(sites.map((s) => s.operator));
    for (const o of ['TWA.wait.add', 'AOL.assert.loosen', 'AOF.assert.flip', 'SOG.selector.generalize', 'SOS.selector.specialize']) assert.ok(ops.has(o), o);
    const m = mutateTestSource(SRC, 'AOF.assert.flip');
    assert.match(m, /\.not\.toHaveText/);
    assert.throws(() => mutateTestSource(SRC, 'TWR.wait.remove'), /site 0 not found/);
  });
});

/* ------------------------------------------------------------- plugins */

describe('plugins', () => {
  const pluginFile = path.join(tmp, 'plugin.js');
  before(async () => {
    fs.writeFileSync(pluginFile, PLUGIN);
    await registry.loadPluginFile(pluginFile);
  });

  test('custom operators are registered on all layers', () => {
    assert.equal(registry.get('XAM.title.remove').layer, 'dom');
    assert.equal(registry.get('XNS.status.teapot').family, 'XNS');
    assert.equal(registry.isBuiltin('XAM.title.remove'), false);
    assert.equal(registry.list().length, 55);
    // loading twice is idempotent
    return registry.loadPluginFile(pluginFile).then(() => assert.equal(registry.list().length, 55));
  });

  test('custom test-script operator works through the public API', () => {
    const out = mutateTestSource(`test('t', async ({ page }) => {\n  await page.goto('/');\n});\n`, 'XTO.goto.remove');
    assert.doesNotMatch(out, /page\.goto/);
  });

  test('invalid definitions are rejected', () => {
    const r = new OperatorRegistry();
    assert.throws(() => r.register({ id: 'bad', layer: 'dom' } as any), /invalid operator id/);
    assert.throws(() => r.register({ id: 'X.y', layer: 'dom' } as any), /"apply" is required/);
    assert.throws(() => r.register({ id: 'SVM.display.none', layer: 'dom', apply: () => null } as any), /already registered/);
  });

  test('custom DOM operators (element and page scope) in the browser', async () => {
    const page = await browser.newPage();
    const h1 = await applyDomMutation(page, { operator: 'XAM.title.remove', selector: '#q' });
    const h2 = await applyDomMutation(page, { operator: 'XPG.body.mark' });
    await page.goto(base);
    assert.equal(await page.getAttribute('#q', 'title'), null);
    assert.equal(await page.getAttribute('html', 'data-x'), '1');
    assert.deepEqual(h1.applied(), ['title removed']);
    assert.deepEqual(h2.applied(), ['marked']);
    await page.close();
  });

  test('custom network operator', async () => {
    const page = await browser.newPage();
    const h = await applyNetworkMutation(page, { operator: 'XNS.status.teapot', url: `${base}/api/items` });
    await page.goto(base);
    const status = await page.evaluate(() => fetch('/api/items').then((r) => r.status));
    assert.equal(status, 418);
    assert.deepEqual(h.applied(), ['teapot']);
    await page.close();
  });
});

/* ------------------------------------------------- runtime instrumentation */

describe('runtime instrumentation', () => {
  test('applyDomMutation applies to already-loaded pages and future navigations', async () => {
    const page = await browser.newPage();
    await page.goto(base);
    const h = await applyDomMutation(page, { operator: 'SVM.display.none', selector: '#go' });
    assert.equal(await page.isVisible('#go'), false);
    await page.reload();
    assert.equal(await page.isVisible('#go'), false);
    assert.ok(h.applied().length >= 2);
    await page.close();
  });

  test('several mutations can be stacked on one page (higher-order mutants)', async () => {
    const page = await browser.newPage();
    await applyDomMutation(page, { operator: 'AAM.placeholder.remove', selector: '#q' });
    await applyDomMutation(page, { operator: 'CDM.text.delete', selector: '#t' });
    await page.goto(base);
    assert.equal(await page.getAttribute('#q', 'placeholder'), null);
    assert.equal(await page.textContent('#t'), '');
    await page.close();
  });

  test('applyNetworkMutation with a built-in payload operator', async () => {
    const page = await browser.newPage();
    const h = await applyNetworkMutation(page, { operator: 'NPE.enum.invalid', url: `${base}/api/items`, params: { fieldName: 'status' } });
    await page.goto(base);
    await page.click('#go');
    await assertText(page, '#st', 'INVALID_STATUS');
    assert.equal(h.applied().length, 1);
    await page.close();
  });

  test('attachRecorder records a crawl that feeds the PWE model', async () => {
    const context = await browser.newContext();
    const rec = await attachRecorder(context);
    const page = await context.newPage();
    await page.goto(base);
    await page.fill('#q', 'x');
    await page.click('#go');
    await assertText(page, '#out', 'a,b');
    await page.waitForTimeout(300);
    const trace = await rec.stop({ testFile: 'crawler', testTitle: 'crawl 1' });
    await context.close();
    assert.ok(trace.interactions.some((i) => i.kind === 'click' && i.selector === '#go'));
    assert.ok(trace.interactions.some((i) => i.kind === 'fill' && i.selector === '#q'));
    const api = trace.network.find((n) => n.endpoint.endsWith('/api/items'));
    assert.ok(api?.json?.fields.status);
    const [p] = buildPweModel(createSuiteTrace([trace]), 2);
    assert.deepEqual(p.selected.map((e) => e.selector).sort(), ['#go', '#q']);
  });
});

async function assertText(page: import('@playwright/test').Page, sel: string, text: string) {
  await page.waitForFunction(([s, t]) => document.querySelector(s)?.textContent === t, [sel, text] as const, { timeout: 3000 });
}

/* ------------------------------------------------------------------ CLI */

describe('CLI', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: tmp, encoding: 'utf8' });

  test('operators --json', () => {
    const ops = JSON.parse(execFileSync(process.execPath, [CLI, 'operators', '--json'], { cwd: tmp, encoding: 'utf8' }));
    assert.equal(ops.length, 51);
    const withPlugin = JSON.parse(execFileSync(process.execPath, [CLI, 'operators', '--json', '--plugin', path.join(tmp, 'plugin.js')], { cwd: tmp, encoding: 'utf8' }));
    assert.equal(withPlugin.length, 55);
  });

  test('sites and mutate on a test file', () => {
    const f = path.join(tmp, 'a.spec.ts');
    fs.writeFileSync(f, `import { test, expect } from '@playwright/test';\ntest('t', async ({ page }) => {\n  await page.waitForSelector('#x');\n  await expect(page.locator('#x')).toBeVisible();\n});\n`);
    const sites = JSON.parse(run('sites', f, '--json').stdout);
    assert.ok(sites.some((s: any) => s.operator === 'TWR.wait.remove'));
    const r = run('mutate', f, '--operator', 'TWR.wait.remove');
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /waitForSelector\('#x'\);/);
  });

  test('init creates a config; usage errors exit with 2', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'init-'));
    const r = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(path.join(dir, 'mlmt.config.json')));
    assert.equal(spawnSync(process.execPath, [CLI, 'init'], { cwd: dir }).status, 2);
    assert.equal(run('nope').status, 2);
    assert.equal(run('run', '--workers', 'x').status, 2);
    assert.equal(run('mutate').status, 2);
  });
});
