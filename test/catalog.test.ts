import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ALL_OPERATORS, DOM_OPERATORS, NETWORK_OPERATORS, TEST_OPERATORS } from '../src/operators/catalog';
import { TEST_OPERATOR_IDS } from '../src/operators/test/astMutator';

test('catalog has 51 operators: 32 DOM, 11 network, 8 test-script (Table 4.2)', () => {
  assert.equal(ALL_OPERATORS.length, 51);
  assert.equal(DOM_OPERATORS.length, 32);
  assert.equal(NETWORK_OPERATORS.length, 11);
  assert.equal(TEST_OPERATORS.length, 8);
  assert.equal(new Set(ALL_OPERATORS.map((o) => o.id)).size, 51);
});

test('category sizes match Table 4.2', () => {
  const count = (c: string) => ALL_OPERATORS.filter((o) => o.category === c).length;
  const expected: Record<string, number> = {
    'Attribute Mutations': 5, 'Content Mutations': 4, 'Event Mutations': 4, 'Style Mutations': 4, 'Tree Mutations': 4,
    'Validation Mutations': 3, 'Accessibility Mutations': 4, 'Resource Mutations': 4, 'Payload Mutations': 5,
    'Status Override': 1, 'Latency Mutations': 3, 'Ordering Mutations': 2, 'Timing Mutations': 2,
    'Oracle Mutations': 4, 'Selector Mutations': 2,
  };
  for (const [c, n] of Object.entries(expected)) assert.equal(count(c), n, c);
});

test('every test-script operator has an AST implementation', () => {
  assert.deepEqual([...TEST_OPERATOR_IDS].sort(), TEST_OPERATORS.map((o) => o.id).sort());
});
