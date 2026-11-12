import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { addField, changeType, dropField, invalidEnum, renameField, reorderArrays } from '../src/operators/network/payload';

test('NPF drops a field (thesis example)', () => {
  assert.deepEqual(dropField({ userId: 1, name: 'u' }, 'userId').value, { name: 'u' });
  assert.equal(dropField({ name: 'u' }, 'userId').changed, false);
  assert.deepEqual(dropField([{ userId: 1 }, { userId: 2, a: 1 }], 'userId').value, [{}, { a: 1 }]);
});

test('NPR renames, NPT converts, NPE invalidates, NPA adds', () => {
  assert.deepEqual(renameField({ username: 'a', x: 1 }, 'username', 'usrname').value, { usrname: 'a', x: 1 });
  assert.deepEqual(changeType({ age: '30' }, 'age').value, { age: 30 });
  assert.deepEqual(changeType({ age: 30 }, 'age').value, { age: '30' });
  assert.equal(changeType({ age: 'abc' }, 'age').changed, false);
  assert.deepEqual(invalidEnum({ status: 'ACTIVE' }, 'status', 'INVALID_STATUS').value, { status: 'INVALID_STATUS' });
  assert.deepEqual(addField({ id: 1 }, 'debug', true).value, { id: 1, debug: true });
  assert.equal(addField('str', 'debug', true).changed, false);
});

test('NOR reverses the first array', () => {
  assert.deepEqual(reorderArrays([1, 2, 3]).value, [3, 2, 1]);
  assert.deepEqual(reorderArrays({ items: [1, 2], total: 2 }).value, { items: [2, 1], total: 2 });
  assert.equal(reorderArrays([1]).changed, false);
  assert.equal(reorderArrays([5, 5]).changed, false);
  const shuffled = reorderArrays([1, 2, 3, 4], 'shuffle', () => 0.999).value as number[];
  assert.notDeepEqual(shuffled, [1, 2, 3, 4]);
});
