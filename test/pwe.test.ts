import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildPweModel, interactionPoints, pweScore, semanticPoints, visibilityPoints } from '../src/pwe/pwe';
import type { ElementInfo, SuiteTrace } from '../src/types';

function el(selector: string, tag: string, attrs: Record<string, string> = {}, visible = true): ElementInfo {
  return {
    selector, tag, attrs, text: '',
    visibility: { inViewport: visible, displayed: visible, opaque: visible, nonZeroSize: visible },
    facts: { textNodeWords: 0, childElementCount: 0, inForm: false, formSelector: null, formControlCount: 0, hasImgDescendant: false, hasImgWithAlt: false, associatedLabel: false, implicitRole: null },
  };
}

test('points per Sec. 4.3.1-4.3.3', () => {
  assert.equal(interactionPoints({ click: 2, fill: 1, focus: 1, hover: 1 }), 20 + 15 + 5 + 3);
  assert.equal(visibilityPoints(el('#a', 'button')), 25);
  assert.equal(visibilityPoints(el('#a', 'button', {}, false)), 0);
  assert.equal(semanticPoints(el('#a', 'button')), 20);
  assert.equal(semanticPoints(el('#a', 'label')), 15);
  assert.equal(semanticPoints(el('#a', 'nav')), 10);
  assert.equal(semanticPoints(el('#a', 'div')), 5);
  assert.equal(semanticPoints(el('#a', 'h1')), 0);
  assert.equal(semanticPoints(el('#a', 'div', { role: 'button' })), 20);
});

test('Eq. 4.1 reproduces the MediaWiki case-study scores', () => {
  assert.equal(pweScore({ interaction: 1, visibility: 1, semantic: 1 }), 1);
  assert.ok(Math.abs(pweScore({ interaction: 1, visibility: 1, semantic: 0.95 }) - 0.985) < 1e-9);
  assert.ok(Math.abs(pweScore({ interaction: 1, visibility: 1, semantic: 0.9 }) - 0.97) < 1e-9);
});

test('ranking keeps the top-N per page and prefers interacted elements', () => {
  const page = 'http://x/edit';
  const trace: SuiteTrace = {
    createdAt: '', baseline: { durationMs: 0, passed: [], failed: [], ok: true },
    tests: [{
      testFile: 'a.spec.ts', testTitle: 't', status: 'passed',
      snapshots: { [page]: {
        '#save': el('#save', 'button'), '#text': el('#text', 'textarea'), '#hidden': el('#hidden', 'button', {}, false),
        '#d': el('#d', 'div'), '#nav': el('#nav', 'nav'),
      } },
      interactions: [
        { kind: 'click', pageKey: page, selector: '#save' },
        { kind: 'fill', pageKey: page, selector: '#text' },
        { kind: 'focus', pageKey: page, selector: '#text' },
      ],
      network: [], resources: [],
    }],
  };
  const [p] = buildPweModel(trace, 3);
  assert.equal(p.candidates, 5);
  assert.deepEqual(p.selected.map((e) => e.selector), ['#text', '#save', '#nav']);
  assert.equal(p.selected[0].score, 1);
  assert.equal(p.selected[0].interactions.fill, 1);
});
