import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { rewriteImports } from '../src/engine/sandbox';

test('redirects @playwright/test and out-of-tree relative imports', () => {
  const src = `import { test, expect } from '@playwright/test';
import { login } from './helpers';
import data from '../fixtures/data.json';
const x = require('../lib/util');
`;
  const out = rewriteImports(src, '/sb/tests/a.spec.ts', '/proj/tests/a.spec.ts', '/proj/tests', '/mlmt/fixture.js');
  assert.match(out, /from '\/mlmt\/fixture\.js'/);
  assert.match(out, /from '\.\/helpers'/);
  assert.match(out, /from '\/proj\/fixtures\/data\.json'/);
  assert.match(out, /require\('\/proj\/lib\/util'\)/);
});
