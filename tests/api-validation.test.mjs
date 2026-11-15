import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMedication, validateAppointment } from '../src/validation.mjs';

test('medication validation rejects malformed times', () => {
  assert.throws(() => validateMedication({ name: 'Test', schedule: '25:99' }));
  assert.equal(validateMedication({ name: 'Test', schedule: '08:30' }).schedule, '08:30');
});

test('appointment validation enforces ISO date', () => {
  assert.throws(() => validateAppointment({ doctor: 'Dr', date: 'tomorrow', time: '12:00' }));
  assert.equal(validateAppointment({ doctor: 'Dr', date: '2026-11-15', time: '12:00' }).date, '2026-11-15');
});
