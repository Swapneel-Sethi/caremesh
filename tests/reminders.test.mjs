import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReminderCandidates, runReminders } from '../src/reminders.mjs';
import { getState } from '../src/data.mjs';

const profile = { name: 'Meera Rao', age: 72 };
const now = new Date('2026-11-15T13:20:00+05:30');

const snapshot = {
  profiles: [profile],
  medications: [
    { id: 'med-upcoming', name: 'Amlodipine 5 mg', schedule: '14:00', status: 'pending', instructions: 'Take after lunch.', frequency: 'Daily' },
    { id: 'med-missed', name: 'Metformin 500 mg', schedule: '12:00', status: 'pending', instructions: 'Take with food.', frequency: 'Daily' },
    { id: 'med-later', name: 'Vitamin D3 1000 IU', schedule: '20:00', status: 'pending', instructions: 'Take after dinner.', frequency: 'Daily' },
    { id: 'med-taken', name: 'Aspirin 75 mg', schedule: '13:10', status: 'taken', instructions: 'Take after breakfast.', frequency: 'Daily' }
  ],
  appointments: [
    { id: 'appt-today', doctor: 'Dr. Ananya Mehta', specialty: 'Cardiology', date: '2026-11-15', time: '16:30', location: 'Apollo Clinic · Bandra', status: 'confirmed', notes: 'Carry previous prescription.' },
    { id: 'appt-later', doctor: 'Dr. Vivek Shah', specialty: 'Physiotherapy', date: '2026-11-17', time: '11:00', location: 'CareWell Rehab', status: 'upcoming', notes: '' }
  ]
};

test('reminder engine finds upcoming medication, missed medication and next appointment', () => {
  const candidates = buildReminderCandidates(snapshot, now);
  assert.equal(candidates.length, 3);
  assert.ok(candidates.some((item) => item.kind === 'medication-upcoming' && item.summary.medicationId === 'med-upcoming'));
  assert.ok(candidates.some((item) => item.kind === 'medication-missed' && item.summary.medicationId === 'med-missed'));
  assert.ok(candidates.some((item) => item.kind === 'appointment-upcoming' && item.summary.appointmentId === 'appt-today'));
});

test('reminder keys are stable and exclude taken medication', () => {
  const first = buildReminderCandidates(snapshot, now).map((item) => item.key);
  const second = buildReminderCandidates(snapshot, now).map((item) => item.key);
  assert.deepEqual(first, second);
  assert.ok(!first.some((key) => key.includes('med-taken')));
  assert.ok(!first.some((key) => key.includes('med-later')));
  assert.ok(first.some((key) => key.startsWith('medication-upcoming:2026-11-15:med-upcoming')));
});

test('reminder email content includes care context but no addresses or internal details', () => {
  const candidates = buildReminderCandidates(snapshot, now);
  const appointment = candidates.find((item) => item.kind === 'appointment-upcoming');
  assert.match(appointment.subject, /Dr\. Ananya Mehta/);
  assert.match(appointment.text, /Sunday, 15 November at 4:30 pm/);
  assert.match(appointment.text, /Apollo Clinic · Bandra/);
  assert.match(appointment.text, /Meera Rao, 72/);
  assert.doesNotMatch(appointment.text, /@/);
  assert.doesNotMatch(appointment.text, /api key|resend|firestore/i);
  const missed = candidates.find((item) => item.kind === 'medication-missed');
  assert.match(missed.subject, /Missed medication/);
  assert.match(missed.text, /Overdue and not recorded/);
});

function decisionSnapshot(schedule) {
  return {
    profiles: [profile],
    medications: [{ id: 'med-missed', name: 'Metformin 500 mg', schedule, status: 'pending', instructions: 'Take with food.', frequency: 'Daily' }],
    appointments: [],
    careTeam: [{ id: 'team-1', role: 'Caregiver' }]
  };
}

function resetReminderState() {
  const state = getState();
  state.events.length = 0;
  state.outbox.length = 0;
  state.reminders.length = 0;
  return state;
}

test('a valid Adaption decision selects the caregiver email path and records an audit event', async () => {
  const state = resetReminderState();
  const result = await runReminders({
    snapshot: decisionSnapshot('12:00'),
    now: new Date('2026-11-15T13:20:00+05:30'),
    decisionProvider: async () => ({
      source: 'adaption',
      action: 'email_caregiver',
      reasonCode: 'repeated_miss',
      confidence: 0.82
    })
  });

  const missed = result.results.find((item) => item.kind === 'medication-missed');
  assert.equal(missed.decisionSource, 'adaption');
  assert.equal(missed.action, 'email_caregiver');
  assert.equal(missed.reasonCode, 'repeated_miss');
  assert.equal(state.outbox.length, 1);

  const event = state.events.find((item) => item.type === 'carepulse_adaption_decision');
  assert.ok(event);
  assert.equal(event.source, 'adaption');
  assert.equal(event.action, 'email_caregiver');
  assert.equal(event.reasonCode, 'repeated_miss');
  assert.equal(event.confidence, 0.82);
  assert.doesNotMatch(JSON.stringify(event), /Meera|@|\+91|Metformin/);
});

test('the reminder workflow continues with a safe fallback when the advisor throws', async () => {
  const state = resetReminderState();
  const result = await runReminders({
    snapshot: decisionSnapshot('12:00'),
    now: new Date('2026-11-15T13:20:00+05:30'),
    decisionProvider: async () => { throw new Error('adaption down'); }
  });

  const missed = result.results.find((item) => item.kind === 'medication-missed');
  assert.equal(missed.decisionSource, 'deterministic_fallback');
  assert.equal(missed.action, 'email_caregiver');
  assert.equal(state.outbox.length, 1);

  const event = state.events.find((item) => item.type === 'carepulse_adaption_decision');
  assert.equal(event.source, 'deterministic_fallback');
});

test('an unsafe hold recommendation is overridden by the server safety gate', async () => {
  const state = resetReminderState();
  const result = await runReminders({
    snapshot: decisionSnapshot('12:00'),
    now: new Date('2026-11-15T13:20:00+05:30'),
    decisionProvider: async () => ({
      source: 'adaption',
      action: 'hold_and_retry',
      reasonCode: 'temporary_retry',
      confidence: 0.9
    })
  });

  const missed = result.results.find((item) => item.kind === 'medication-missed');
  assert.notEqual(missed.status, 'deferred');
  assert.equal(missed.action, 'email_caregiver');
  assert.equal(missed.decisionSource, 'deterministic_fallback');
  assert.equal(state.outbox.length, 1);
});

test('a hold recommendation is honoured only within the safety window', async () => {
  const state = resetReminderState();
  const result = await runReminders({
    snapshot: decisionSnapshot('12:45'),
    now: new Date('2026-11-15T13:20:00+05:30'),
    decisionProvider: async () => ({
      source: 'adaption',
      action: 'hold_and_retry',
      reasonCode: 'temporary_retry',
      confidence: 0.7
    })
  });

  const missed = result.results.find((item) => item.kind === 'medication-missed');
  assert.equal(missed.status, 'deferred');
  assert.equal(missed.action, 'hold_and_retry');
  assert.equal(state.outbox.length, 0);
  assert.equal(state.reminders.length, 0);

  const event = state.events.find((item) => item.type === 'carepulse_adaption_decision');
  assert.equal(event.action, 'hold_and_retry');
});
