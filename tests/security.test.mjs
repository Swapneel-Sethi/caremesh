import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPasscode, verifyPasscode, createSession, readSession } from '../src/security.mjs';

test('passcodes are verifiable but not stored in plaintext', () => {
  const result = hashPasscode('1234', 'fixed-salt');
  assert.notEqual(result.hash, '1234');
  assert.equal(verifyPasscode('1234', result.salt, result.hash), true);
  assert.equal(verifyPasscode('9999', result.salt, result.hash), false);
});

test('signed sessions reject tampering', () => {
  const token = createSession('usr-elder', 'secret', 60);
  assert.deepEqual(readSession(token, 'secret')?.userId, 'usr-elder');
  assert.equal(readSession(`${token}x`, 'secret'), null);
});
