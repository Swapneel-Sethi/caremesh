import test from 'node:test';
import assert from 'node:assert/strict';

function canWrite(role) { return ['elder', 'caregiver'].includes(role); }

test('family role is read-only for protected writes', () => {
  assert.equal(canWrite('family'), false);
  assert.equal(canWrite('elder'), true);
  assert.equal(canWrite('caregiver'), true);
});
