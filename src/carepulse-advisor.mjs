// CarePulse escalation advisor.
//
// Adaption recommends one action from a fixed operational allowlist. It never
// executes anything and never sees identifiers, contact details, notes or
// dosage text. CareMesh validates the recommendation again before acting and
// falls back to the existing voice-first policy on any failure.

import { config } from './config.mjs';
import { createAdaptionResponse, findFunctionCall, parseFunctionArguments } from './adaption.mjs';

export const CAREPULSE_ACTIONS = Object.freeze(['voice_check_in', 'email_caregiver', 'hold_and_retry']);

export const CAREPULSE_REASON_CODES = Object.freeze([
  'recent_miss_low_urgency',
  'repeated_miss',
  'caregiver_followup_needed',
  'voice_check_in_preferred',
  'temporary_retry',
  'insufficient_context'
]);

const ACTION_SET = new Set(CAREPULSE_ACTIONS);
const REASON_SET = new Set(CAREPULSE_REASON_CODES);

const CONTEXT_FIELDS = Object.freeze([
  'medicationStatus',
  'scheduledTime',
  'currentTime',
  'minutesLate',
  'recentReminderAttempts',
  'previousReminderOutcomes',
  'timeOfDay',
  'caregiverAvailability',
  'priorEscalationOutcome',
  'voiceReady'
]);

const CONTEXT_TYPES = Object.freeze({
  medicationStatus: 'string',
  scheduledTime: 'string',
  currentTime: 'string',
  minutesLate: 'number',
  recentReminderAttempts: 'number',
  previousReminderOutcomes: 'strings',
  timeOfDay: 'string',
  caregiverAvailability: 'string',
  priorEscalationOutcome: 'string',
  voiceReady: 'boolean'
});

const HOLD_MAX_MINUTES_LATE = 45;
const HOLD_MAX_ATTEMPTS = 2;

const INSTRUCTIONS = `You are CarePulse, the escalation advisor for a medication reminder workflow.
Choose the safest operational escalation action for a missed medication reminder from the fixed allowlist.
You must call the submit_decision function exactly once and use only its schema.

Rules:
- action must be exactly one of: voice_check_in, email_caregiver, hold_and_retry.
- reason_code must be exactly one of: recent_miss_low_urgency, repeated_miss, caregiver_followup_needed, voice_check_in_preferred, temporary_retry, insufficient_context.
- confidence must be a number between 0 and 1.
- never invent actions, never suggest medication changes, dosage, diagnosis or medical advice.
- never attempt to contact anyone or suppress a required caregiver escalation.
- if the context is insufficient, choose email_caregiver with insufficient_context.
- prefer hold_and_retry only for a recent miss with no repeated attempts and low urgency.
- the server validates your decision and decides whether to execute it.`;

const SUBMIT_DECISION_TOOL = Object.freeze({
  type: 'function',
  name: 'submit_decision',
  description: 'Submit exactly one CarePulse escalation decision. The server validates and executes it.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CAREPULSE_ACTIONS],
        description: 'The recommended operational escalation action.'
      },
      reason_code: {
        type: 'string',
        enum: [...CAREPULSE_REASON_CODES],
        description: 'A fixed operational reason code.'
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence in this recommendation.'
      }
    },
    required: ['action', 'reason_code', 'confidence'],
    additionalProperties: false
  }
});

function cleanString(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : null;
}

export function sanitizeCarePulseContext(context = {}) {
  const sanitized = {};
  for (const field of CONTEXT_FIELDS) {
    if (!(field in context)) continue;
    const value = context[field];
    const type = CONTEXT_TYPES[field];
    if (type === 'string' && typeof value === 'string') {
      sanitized[field] = cleanString(value, 64);
    } else if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      sanitized[field] = value;
    } else if (type === 'boolean' && typeof value === 'boolean') {
      sanitized[field] = value;
    } else if (type === 'strings' && Array.isArray(value)) {
      sanitized[field] = value
        .filter((item) => typeof item === 'string')
        .slice(0, 5)
        .map((item) => item.slice(0, 32));
    }
  }
  return sanitized;
}

export function isValidCarePulseDecision(decision) {
  return Boolean(
    decision &&
    ACTION_SET.has(decision.action) &&
    REASON_SET.has(decision.reasonCode) &&
    typeof decision.confidence === 'number' &&
    Number.isFinite(decision.confidence) &&
    decision.confidence >= 0 &&
    decision.confidence <= 1
  );
}

export function deterministicDecision(context = {}) {
  const attempts = Number(context.recentReminderAttempts) || 0;
  if (context.voiceReady === true) {
    return {
      source: 'deterministic_fallback',
      action: 'voice_check_in',
      reasonCode: attempts > 0 ? 'repeated_miss' : 'voice_check_in_preferred',
      confidence: 0.6
    };
  }
  return {
    source: 'deterministic_fallback',
    action: 'email_caregiver',
    reasonCode: attempts > 0 ? 'repeated_miss' : 'caregiver_followup_needed',
    confidence: 0.6
  };
}

// Final server-side gate. The model recommendation is data, never authority.
export function enforceDecisionSafety(decision, context = {}) {
  const candidate = {
    source: decision?.source === 'deterministic_fallback' ? 'deterministic_fallback' : 'adaption',
    action: decision?.action,
    reasonCode: decision?.reasonCode,
    confidence: decision?.confidence
  };

  if (!isValidCarePulseDecision(candidate)) {
    return { ...deterministicDecision(context), safetyOverride: true };
  }

  if (candidate.action === 'hold_and_retry') {
    const minutesLate = Number(context.minutesLate) || 0;
    const attempts = Number(context.recentReminderAttempts) || 0;
    if (minutesLate > HOLD_MAX_MINUTES_LATE || attempts >= HOLD_MAX_ATTEMPTS) {
      return { ...deterministicDecision(context), safetyOverride: true };
    }
  }

  return candidate;
}

function normalizeDecision(args) {
  if (!args) return null;
  const decision = {
    source: 'adaption',
    action: typeof args.action === 'string' ? args.action.trim() : '',
    reasonCode: typeof args.reason_code === 'string' ? args.reason_code.trim() : '',
    confidence: typeof args.confidence === 'number' ? args.confidence : Number.NaN
  };
  return isValidCarePulseDecision(decision) ? decision : null;
}

export async function decideCarePulseEscalation(context = {}, options = {}) {
  const sanitized = sanitizeCarePulseContext(context);

  try {
    const response = await createAdaptionResponse({
      model: options.model || config.adaptionModel,
      instructions: INSTRUCTIONS,
      input: JSON.stringify({ escalation_context: sanitized }),
      tools: [SUBMIT_DECISION_TOOL],
      toolChoice: { type: 'function', name: 'submit_decision' },
      maxToolCalls: 1,
      maxOutputTokens: options.maxOutputTokens || config.adaptionMaxOutputTokens,
      temperature: 0,
      store: false,
      enabled: options.enabled,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl
    });

    const call = findFunctionCall(response, 'submit_decision');
    if (!call) return deterministicDecision(sanitized);

    const decision = normalizeDecision(parseFunctionArguments(call));
    return decision || deterministicDecision(sanitized);
  } catch {
    return deterministicDecision(sanitized);
  }
}
