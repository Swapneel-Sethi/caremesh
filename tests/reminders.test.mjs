import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReminderCandidates } from '../src/reminders.mjs';

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
