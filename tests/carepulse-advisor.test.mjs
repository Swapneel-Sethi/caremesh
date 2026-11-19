import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAREPULSE_ACTIONS,
  CAREPULSE_REASON_CODES,
  decideCarePulseEscalation,
  deterministicDecision,
  enforceDecisionSafety,
  sanitizeCarePulseContext
} from '../src/carepulse-advisor.mjs';

const options = {
  enabled: true,
  apiKey: 'unit-test-key',
  baseUrl: 'https://example.test/api/v1',
  timeoutMs: 500
};

const context = {
  medicationStatus: 'missed',
  scheduledTime: '12:00',
  currentTime: '12:50',
  minutesLate: 50,
  recentReminderAttempts: 1,
  previousReminderOutcomes: ['preview'],
  timeOfDay: 'afternoon',
  caregiverAvailability: 'available',
  priorEscalationOutcome: 'none',
  voiceReady: false
};

function adaptionStub(args, output) {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          status: 'completed',
          output: output || [{
            type: 'function_call',
            name: 'submit_decision',
            call_id: 'call_1',
            arguments: JSON.stringify(args)
          }]
        };
      }
    };
  };
  return { fetchImpl, captured: () => captured };
}

test('a valid submit_decision call is normalized', async () => {
  const stub = adaptionStub({ action: 'email_caregiver', reason_code: 'repeated_miss', confidence: 0.82 });
  const decision = await decideCarePulseEscalation(context, { ...options, fetchImpl: stub.fetchImpl });

  assert.deepEqual(decision, {
    source: 'adaption',
    action: 'email_caregiver',
    reasonCode: 'repeated_miss',
    confidence: 0.82
  });

  const body = stub.captured().body;
  assert.equal(body.tool_choice.name, 'submit_decision');
  assert.equal(body.max_tool_calls, 1);
  assert.equal(body.store, false);
  assert.equal(body.tools[0].name, 'submit_decision');
  assert.deepEqual(body.tools[0].parameters.properties.action.enum, [...CAREPULSE_ACTIONS]);
  assert.deepEqual(body.tools[0].parameters.properties.reason_code.enum, [...CAREPULSE_REASON_CODES]);
  assert.equal(body.tools[0].parameters.additionalProperties, false);
});

test('invalid action, reason code and confidence fall back deterministically', async () => {
  const cases = [
    { action: 'send_ambulance', reason_code: 'repeated_miss', confidence: 0.9 },
    { action: 'email_caregiver', reason_code: 'diagnose_now', confidence: 0.9 },
    { action: 'email_caregiver', reason_code: 'repeated_miss', confidence: 1.5 },
    { action: 'email_caregiver', reason_code: 'repeated_miss', confidence: '0.9' },
    { action: 'email_caregiver', reason_code: 'repeated_miss' }
  ];

  for (const args of cases) {
    const stub = adaptionStub(args);
    const decision = await decideCarePulseEscalation(context, { ...options, fetchImpl: stub.fetchImpl });
    assert.equal(decision.source, 'deterministic_fallback');
    assert.equal(decision.action, 'email_caregiver');
  }
});

test('confidence boundaries 0 and 1 are accepted', async () => {
  for (const confidence of [0, 1]) {
    const stub = adaptionStub({ action: 'voice_check_in', reason_code: 'voice_check_in_preferred', confidence });
    const decision = await decideCarePulseEscalation(context, { ...options, fetchImpl: stub.fetchImpl });
    assert.equal(decision.source, 'adaption');
    assert.equal(decision.confidence, confidence);
  }
});

test('a function call with the wrong name falls back', async () => {
  const stub = adaptionStub(null, [{ type: 'function_call', name: 'other_tool', call_id: 'call_2', arguments: '{"action":"email_caregiver"}' }]);
  const decision = await decideCarePulseEscalation(context, { ...options, fetchImpl: stub.fetchImpl });
  assert.equal(decision.source, 'deterministic_fallback');
});

test('a response without the decision function call falls back', async () => {
  const stub = adaptionStub(null, [{ type: 'message', content: [{ type: 'output_text', text: 'Call the caregiver.' }] }]);
  const decision = await decideCarePulseEscalation(context, { ...options, fetchImpl: stub.fetchImpl });
  assert.equal(decision.source, 'deterministic_fallback');
  assert.equal(decision.action, 'email_caregiver');
});

test('disabled or failing Adaption never throws', async () => {
  const disabled = await decideCarePulseEscalation(context, { ...options, enabled: false, fetchImpl: async () => { throw new Error('must not run'); } });
  assert.equal(disabled.source, 'deterministic_fallback');

  const failing = await decideCarePulseEscalation(context, {
    ...options,
    fetchImpl: async () => ({ ok: false, status: 500, async json() { return {}; } })
  });
  assert.equal(failing.source, 'deterministic_fallback');
});

test('only allowlisted operational fields are sent to Adaption', async () => {
  const stub = adaptionStub({ action: 'email_caregiver', reason_code: 'repeated_miss', confidence: 0.7 });
  await decideCarePulseEscalation({
    ...context,
    elderName: 'Meera Rao',
    caregiverName: 'Priya Shah',
    phone: '+919999999999',
    email: 'meera@example.com',
    userId: 'usr-elder',
    recipientId: 'demo-recipient',
    dosage: '500 mg',
    medicationName: 'Metformin 500 mg',
    instructions: 'Take with food.',
    medicalNotes: 'History of falls.'
  }, { ...options, fetchImpl: stub.fetchImpl });

  const body = stub.captured().body;
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /Meera|Priya|\+91999|meera@|usr-elder|demo-recipient|500 mg|Metformin|falls/);

  const sent = JSON.parse(body.input).escalation_context;
  assert.deepEqual(Object.keys(sent).sort(), Object.keys(context).sort());
  assert.equal(sent.dosage, undefined);
  assert.equal(sent.medicationName, undefined);
});

test('sanitizer drops unknown and nested fields', () => {
  const sanitized = sanitizeCarePulseContext({
    minutesLate: 40,
    timeOfDay: 'evening',
    previousReminderOutcomes: ['preview', 7, 'sent'],
    voiceReady: 'yes',
    nested: { name: 'Meera' },
    notes: ['private']
  });

  assert.deepEqual(sanitized, {
    minutesLate: 40,
    timeOfDay: 'evening',
    previousReminderOutcomes: ['preview', 'sent']
  });
});

test('sanitizer caps field length and list size', () => {
  const sanitized = sanitizeCarePulseContext({
    medicationStatus: 'x'.repeat(100),
    previousReminderOutcomes: ['a'.repeat(50), 'b', 'c', 'd', 'e', 'f', 'g'],
    minutesLate: Number.POSITIVE_INFINITY,
    voiceReady: true
  });

  assert.equal(sanitized.medicationStatus.length, 64);
  assert.equal(sanitized.previousReminderOutcomes.length, 5);
  assert.equal(sanitized.previousReminderOutcomes[0].length, 32);
  assert.equal('minutesLate' in sanitized, false);
  assert.equal(sanitized.voiceReady, true);
});

test('deterministic fallback preserves voice-first behaviour', () => {
  assert.equal(deterministicDecision({ voiceReady: true }).action, 'voice_check_in');
  assert.equal(deterministicDecision({ voiceReady: false }).action, 'email_caregiver');
  assert.equal(deterministicDecision({ voiceReady: true, recentReminderAttempts: 1 }).reasonCode, 'repeated_miss');
});

test('the server gate overrides unsafe or stale hold actions', () => {
  const hold = { source: 'adaption', action: 'hold_and_retry', reasonCode: 'temporary_retry', confidence: 0.7 };
  assert.equal(enforceDecisionSafety(hold, { ...context, minutesLate: 35, recentReminderAttempts: 0 }).action, 'hold_and_retry');

  const overdue = enforceDecisionSafety(hold, { ...context, minutesLate: 90, recentReminderAttempts: 0 });
  assert.equal(overdue.action, 'email_caregiver');
  assert.equal(overdue.source, 'deterministic_fallback');
  assert.equal(overdue.safetyOverride, true);

  const repeated = enforceDecisionSafety(hold, { ...context, minutesLate: 35, recentReminderAttempts: 2 });
  assert.notEqual(repeated.action, 'hold_and_retry');

  const invalid = enforceDecisionSafety({ source: 'adaption', action: 'send_ambulance', reasonCode: 'repeated_miss', confidence: 0.9 }, context);
  assert.equal(invalid.action, 'email_caregiver');
  assert.equal(invalid.safetyOverride, true);
});
