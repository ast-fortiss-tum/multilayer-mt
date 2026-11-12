import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEngine, evaluateTestSuite, runMutationAnalysis, AbortError, MutantResult } from '../../src/index';

/**
 * End-to-end tests of the programmatic API against examples/todo-app
 * (the engine starts the demo server itself). Run with `npm run test:e2e`.
 */
const DEMO = path.resolve(__dirname, '../../../examples/todo-app');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmt-e2e-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const pluginFile = path.join(tmp, 'plugin.js');
fs.writeFileSync(pluginFile, `module.exports = { name: 'e2e', operators: [
  { id: 'XNS.status.teapot', layer: 'network', handle: async ({ route, applied }) => { applied('418'); await route.fulfill({ status: 418, body: '[]' }); } },
] };`);

const base = {
  config: path.join(DEMO, 'mlmt.config.json'),
  overrides: { outputDir: path.join(tmp, 'out'), maxPwe: 3, workers: 4, plugins: [pluginFile] },
};

test('runMutationAnalysis: full pipeline with events and a plugin operator', { timeout: 300_000 }, async () => {
  const seen: MutantResult[] = [];
  const report = await runMutationAnalysis({
    ...base,
    overrides: {
      ...base.overrides,
      operators: { include: ['SVM.display.none', 'NSO.status.override', 'XNS.status.teapot', 'AOF.assert.flip'] },
      network: { include: '/api/todos$' },
      test: { maxSitesPerOperator: 1 },
    },
    onResult: (r) => seen.push(r),
  });
  assert.equal(report.tool, 'MultilayerMT');
  assert.equal(seen.length, report.results.length);
  const byOp = (op: string) => report.results.filter((r) => r.mutant.operator === op);
  assert.ok(byOp('SVM.display.none').length > 0);
  // the plugin operator ran inside the Playwright workers and killed a mutant
  assert.ok(byOp('XNS.status.teapot').some((r) => r.status === 'KILLED'), JSON.stringify(byOp('XNS.status.teapot').map((r) => r.reason)));
  assert.ok(byOp('NSO.status.override').some((r) => r.status === 'KILLED'));
  assert.ok(byOp('AOF.assert.flip').every((r) => r.status === 'KILLED'));
  assert.equal(report.totals.error + report.totals.timeout, 0);
  // reporters are off by default in the API
  assert.equal(fs.existsSync(path.join(tmp, 'out', 'report-pwe3.html')), false);
  // sandboxes are cleaned up
  assert.equal(fs.existsSync(path.join(DEMO, '.mutants')), false);
});

test('engine: step-by-step use, events and abort', { timeout: 300_000 }, async () => {
  const engine = await createEngine({ ...base, overrides: { ...base.overrides, layers: ['dom'] } });
  const phases: string[] = [];
  engine.on('phase', (p) => phases.push(p));
  const ac = new AbortController();
  engine.on('mutant:result', (_r, p) => {
    if (p.done >= 2) ac.abort();
  });
  await assert.rejects(engine.run({ reuseTrace: true, signal: ac.signal, reporters: false }), AbortError);
  assert.ok(phases.includes('execute'));
  assert.equal(fs.existsSync(path.join(DEMO, '.mutants')), false);
});

test('evaluateTestSuite: score an in-memory generated test', { timeout: 300_000 }, async () => {
  const generated = `import { test, expect } from '@playwright/test';
test('generated: login and see todos', async ({ page }) => {
  await page.goto('/');
  await page.fill('#email', 'alice@example.com');
  await page.fill('#password', 'secret1');
  await page.click('#login-btn');
  await expect(page.locator('#todo-list li')).toHaveCount(2);
});
`;
  const report = await evaluateTestSuite({ 'generated/gen1.spec.ts': generated }, {
    ...base,
    onlyInline: true,
    overrides: { ...base.overrides, outputDir: path.join(tmp, 'gen'), operators: { include: ['SVM.display.none', 'NSO.status.override', 'AOF.assert.flip'] } },
  });
  assert.ok(report.results.length > 0);
  // only the generated test was traced and executed
  const files = new Set(report.results.flatMap((r) => r.tests.map((t) => t.file)));
  assert.deepEqual([...files], ['generated/gen1.spec.ts']);
  assert.ok(report.results.some((r) => r.mutant.layer === 'test' && r.mutant.target.kind === 'test' && r.mutant.target.file === 'generated/gen1.spec.ts'));
  assert.ok(report.totals.killed > 0);
  // the generated file never touched the project
  assert.equal(fs.existsSync(path.join(DEMO, 'tests', 'generated')), false);
});
