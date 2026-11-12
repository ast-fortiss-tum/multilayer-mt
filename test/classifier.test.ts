import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classify, countResults, gapCategory } from '../src/engine/classifier';
import type { RunOutcome } from '../src/engine/executor';
import type { MutantDescriptor, MutantResult } from '../src/types';

const m = (layer: 'dom' | 'network' | 'test'): MutantDescriptor => ({
  id: 'X', operator: 'SVM.display.none', layer, params: {}, testFiles: [],
  target: { kind: 'dom', pageKey: 'p', selector: '#a', description: '' },
});
const run = (statuses: string[], extra: Partial<RunOutcome> = {}): RunOutcome => ({
  exitCode: 0, timedOut: false, durationMs: 1, errors: [], reportFound: true, stderr: '',
  tests: statuses.map((s, i) => ({ title: `t${i}`, file: 'a.spec.ts', status: s })), ...extra,
});
const base = new Set(['a.spec.ts :: t0', 'a.spec.ts :: t1']);

test('decision tree of Fig. 4.4', () => {
  assert.equal(classify(m('dom'), run(['expected', 'unexpected']), base, 1).status, 'KILLED');
  assert.equal(classify(m('dom'), run(['expected', 'expected']), base, 1).status, 'SURVIVED');
  assert.equal(classify(m('dom'), run(['expected', 'unexpected']), base, 0).status, 'SKIPPED');
  assert.equal(classify(m('dom'), run([], { reportFound: false }), base, 1).status, 'ERROR');
  assert.equal(classify(m('dom'), run([], { timedOut: true }), base, 1).status, 'TIMEOUT');
  // a test that already failed in the baseline cannot kill a mutant
  assert.equal(classify(m('test'), run(['expected', 'expected', 'unexpected']), base, 1).status, 'SURVIVED');
});

test('metrics of Sec. 5.2', () => {
  const r = (status: MutantResult['status']): MutantResult => ({ mutant: m('dom'), status, applied: true, applications: 1, durationMs: 1, tests: [] });
  const c = countResults([r('KILLED'), r('KILLED'), r('SURVIVED'), r('SKIPPED')]);
  assert.equal(c.generated, 4);
  assert.equal(c.executed, 3);
  assert.equal(c.mutationScore, 2 / 3);
  assert.equal(c.applicability, 3 / 4);
  assert.equal(gapCategory('NLF.delay.fixed'), 'Timing Dependencies');
  assert.equal(gapCategory('NSO.status.override'), 'Missing Error Handling');
  assert.equal(gapCategory('AAM.placeholder.remove'), 'Weak Assertions');
});
