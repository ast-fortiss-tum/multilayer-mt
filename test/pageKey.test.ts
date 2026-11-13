import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normalizeKey, pageKeyOf, urlBaseOf } from '../src/util/pageKey';
import { DEFAULT_CONFIG, validateConfig } from '../src/config';

const RULES: Array<[string, string]> = [['Q9[0-9a-f]{8}', 'Q9#']];

test('pageKeyOf selects and sorts query parameters', () => {
  assert.equal(pageKeyOf('http://h/index.php?b=2&a=1&title=X', 'all'), 'http://h/index.php?a=1&b=2&title=X');
  assert.equal(pageKeyOf('http://h/index.php?b=2&title=X', ['title']), 'http://h/index.php?title=X');
  assert.equal(pageKeyOf('http://h/index.php?b=2', 'none'), 'http://h/index.php');
});

test('pageKeyNormalize makes run-specific ids stable', () => {
  const a = pageKeyOf('http://h/index.php/Software_testing_Q9a1b2c3d4', 'all', RULES);
  const b = pageKeyOf('http://h/index.php/Software_testing_Q9ffffffff', 'all', RULES);
  assert.equal(a, 'http://h/index.php/Software_testing_Q9#');
  assert.equal(a, b);
  assert.equal(
    pageKeyOf('http://h/index.php?title=Page%20Q9a1b2c3d4&action=edit', ['title', 'action'], RULES),
    'http://h/index.php?action=edit&title=Page Q9#',
  );
  assert.equal(urlBaseOf('http://h/rest.php/v1/page/X_Q9a1b2c3d4?x=1', RULES), 'http://h/rest.php/v1/page/X_Q9#');
  assert.equal(normalizeKey('unchanged', undefined), 'unchanged');
});

test('config validation rejects malformed pageKeyNormalize', () => {
  const errsOf = (v: unknown) => {
    try {
      validateConfig({ ...DEFAULT_CONFIG, app: 'x', projectRoot: '.', pageKeyNormalize: v } as any);
      return '';
    } catch (e) {
      return String(e);
    }
  };
  assert.match(errsOf([['(', 'x']]), /invalid regex/);
  assert.match(errsOf(['abc']), /pairs/);
});
