// CarePulse AI voice check-in.
//
// One state machine serves three entry points:
//   1. CarePulse detecting a missed dose (automatic)
//   2. a caregiver pressing "AI voice check-in" (manual, real call)
//   3. the judge demo simulator (no telephony required)
//
// The agent only ever coordinates the care workflow. It records whether the
// scheduled medication was confirmed. It never gives dosage or medical advice.

import crypto from 'node:crypto';
import { config } from './config.mjs';
import {
  getCareRecipient,
  createVoiceSession,
  getVoiceSession,
  claimVoiceSession,
  updateVoiceSession,
  createVoiceCallRecord,
  persistEvent,
  persistMedicationUpdate,
  domainSnapshot
} from './store.mjs';
import { classifyVoiceIntent } from './voice-intent.mjs';
import { sendReminder } from './email.mjs';
import { scheduleLabel, localParts } from './time.mjs';

const DEMO_RECIPIENT_ID = 'demo-recipient';
const SESSION_TTL_MS = 12 * 60 * 1000;
const TAKEN = 'taken';

const OUTCOME_REASONS = {
  missed: 'Elder reported medication not taken',
  help_requested: 'Elder requested caregiver help',
  unclear: 'Response unclear after the allowed attempts',
  no_answer: 'No answer',
  busy: 'Phone line was busy',
  failed: 'Call failed',
  canceled: 'Call was canceled'
};

let twilioClientPromise = null;

export function isVoiceReady() {
  return Boolean(
    config.voiceEnabled &&
    config.voiceProvider === 'twilio' &&
    config.twilioAccountSid &&
    config.twilioAuthToken &&
    config.twilioFromNumber
  );
}

export function voiceProviderLabel() {
  return isVoiceReady() ? 'twilio' : 'simulator';
}

export function maskPhone(number) {
  const value = String(number || '');
  if (value.length <= 4) return value ? '****' : '';
  return `****${value.slice(-4)}`;
}

function actorFor(session) {
  return {
    id: 'carepulse-voice',
    name: 'CarePulse Voice Agent',
    role: 'caregiver',
    status: 'active',
    source: 'voice',
    recipientId: session.recipientId
  };
}

function recipientIdFor(user) {
  if (!user) return null;
  if (user.source === 'local') return DEMO_RECIPIENT_ID;
  return user.recipientId || null;
}

async function loadTwilio() {
  if (!twilioClientPromise) {
    twilioClientPromise = import('twilio')
      .then((mod) => mod.default || mod)
      .catch(() => null);
  }
  return twilioClientPromise;
}

function withinCallWindow(window, timeZone) {
  if (!window || typeof window !== 'string') return true;
  const match = window.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return true;
  const [, fromHour, fromMinute, toHour, toMinute] = match.map(Number);
  const now = localParts(new Date(), timeZone || config.reminderTimeZone);
  const after = now.minutes >= fromHour * 60 + fromMinute;
  const before = now.minutes <= toHour * 60 + toMinute;
  return after && before;
}

// Resolves who may be called, without ever returning the number to a caller
// outside the backend. Consent must be explicit: a recipient must have
// allowVoiceCalls === true, except the demo test recipient which is enabled
// explicitly through CARE_VOICE_ENABLED + CARE_VOICE_PHONE.
export async function resolveVoiceTarget(user) {
  const recipientId = recipientIdFor(user);
  if (!recipientId) return { ok: false, reason: 'no_recipient' };

  const recipient = await getCareRecipient(recipientId).catch(() => null);
  const demoConfigured = recipientId === DEMO_RECIPIENT_ID && config.voiceEnabled && Boolean(config.voicePhone);
  const phone = recipient?.voicePhone || (recipientId === DEMO_RECIPIENT_ID ? config.voicePhone : '') || '';
  const consented = recipient?.allowVoiceCalls === true || demoConfigured;

  if (!phone) return { ok: false, reason: 'no_phone' };
  if (!consented) return { ok: false, reason: 'no_consent' };
  if (!withinCallWindow(recipient?.voiceCallWindow, recipient?.timezone)) {
    return { ok: false, reason: 'outside_call_window' };
  }

  return {
    ok: true,
    recipientId,
    phone,
    phoneMasked: maskPhone(phone),
    language: recipient?.voiceLanguage || config.voiceLanguage,
    displayName: recipient?.preferredName || recipient?.displayName || 'there'
  };
}

function voiceSetupMessage(reason) {
  if (reason === 'no_phone' || reason === 'no_consent') return 'Voice calling is not configured for this elder.';
  if (reason === 'outside_call_window') return 'Voice calling is outside this elder\'s preferred calling window.';
  return 'Voice calling is not configured.';
}

async function findMedication(user, medicationId) {
  const snapshot = await domainSnapshot(user);
  return (snapshot.medications || []).find((medication) => medication.id === medicationId) || null;
}

function buildSession({ target, medication }) {
  return {
    id: crypto.randomBytes(24).toString('base64url'),
    recipientId: target.recipientId,
    medicationId: medication.id,
    medicationName: medication.name,
    medicationSchedule: medication.schedule,
    displayName: target.displayName || '',
    status: 'pending',
    attempt: 1,
    callSid: null,
    provider: 'twilio',
    toMasked: target.phoneMasked,
    language: target.language,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };
}

function publicOrigin() {
  return (config.voicePublicOrigin || config.vercelOrigin || config.appOrigin || 'https://caremesh-one.vercel.app').replace(/\/$/, '');
}

function providerReason(error) {
  const code = Number(error?.code || 0);
  // Twilio error mapping is best effort. India destinations need a permitted
  // caller ID from outside India; surfacing that as a setup error lets the caregiver
  // fix configuration instead of retrying an impossible call.
  if ([21210, 21212, 21215, 21606].includes(code)) return 'caller_id_not_supported';
  if ([21211, 21214, 21217, 13224].includes(code)) return 'invalid_to_number';
  return 'provider_error';
}

async function initiateCall(session, attempt) {
  if (!isVoiceReady()) return { ok: false, reason: 'not_configured' };
  const target = await resolveVoiceTarget({ source: 'voice', recipientId: session.recipientId });
  if (!target.ok) return { ok: false, reason: target.reason };

  const twilio = await loadTwilio();
  if (!twilio) return { ok: false, reason: 'library_missing' };

  try {
    const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
    const call = await client.calls.create({
      to: target.phone,
      from: config.twilioFromNumber,
      url: `${publicOrigin()}/api/voice/twiml/start?session=${encodeURIComponent(session.id)}`,
      statusCallback: `${publicOrigin()}/api/voice/status?session=${encodeURIComponent(session.id)}`,
      statusCallbackEvent: ['completed'],
      statusCallbackMethod: 'POST',
      timeout: 25
    });
    await updateVoiceSession(session.id, { status: 'calling', callSid: call.sid, attempt });
    return { ok: true, callSid: call.sid };
  } catch (error) {
    console.error('voice_provider_error', { code: error?.code || null, reason: providerReason(error) });
    return { ok: false, reason: providerReason(error) };
  }
}

// Starts a check-in. `mode: 'call'` places a real Twilio call, anything else
// prepares the session for the simulator or a later call.
export async function startVoiceCheckIn({ user, medicationId, mode = 'auto' }) {
  if (!isVoiceReady()) {
    return { status: 'unavailable', reason: 'not_configured', message: 'Voice calling is not configured.' };
  }
  const medication = await findMedication(user, medicationId);
  if (!medication) return { status: 'not_found', message: 'Medication not found.' };

  const target = await resolveVoiceTarget(user);
  if (!target.ok) return { status: 'unavailable', reason: target.reason, message: voiceSetupMessage(target.reason) };

  const session = await createVoiceSession(buildSession({ target, medication }));

  if (mode !== 'call') {
    return { status: 'prepared', provider: 'twilio', medicationId, sessionId: session.id };
  }

  const call = await initiateCall(session, 1);
  if (!call.ok) {
    await updateVoiceSession(session.id, { status: 'failed', outcome: 'failed', reason: call.reason });
    return {
      status: 'failed',
      reason: call.reason,
      medicationId,
      sessionId: session.id,
      message: call.reason === 'caller_id_not_supported'
        ? 'The configured Twilio caller ID cannot call this destination. Use an international caller ID for Indian numbers.'
        : 'The voice call could not be started.'
    };
  }

  await persistEvent(actorFor(session), {
    at: new Date().toISOString(),
    title: 'AI voice check-in initiated',
    actor: 'CarePulse Voice Agent',
    type: 'voice',
    detail: `${medication.name} · ${scheduleLabel(medication.schedule)} · calling ${target.phoneMasked}`,
    recipientId: session.recipientId
  });

  return { status: 'queued', provider: 'twilio', medicationId, sessionId: session.id, callSid: call.callSid };
}

// Called by CarePulse when a dose is missed and voice is configured.
export async function startAutomatedVoiceCheckIn({ user, medicationId }) {
  return startVoiceCheckIn({ user, medicationId, mode: 'call' });
}

function outcomeEvent(outcome, reason) {
  if (outcome === TAKEN) {
    return { title: 'Medication confirmed by AI voice check-in', detail: reason, type: 'medication' };
  }
  if (['no_answer', 'busy', 'failed', 'canceled'].includes(outcome)) {
    return { title: 'AI voice call could not complete', detail: reason, type: 'security' };
  }
  return { title: 'AI voice check-in escalated to caregiver', detail: reason, type: 'security' };
}

// Applies the outcome of a claimed session exactly once. Both the Twilio
// webhook and the simulator funnel through here so demo behaviour cannot drift
// from production behaviour.
async function applyOutcome(session, { outcome, reason, attempt }) {
  const actor = actorFor(session);
  const medicationStatus = outcome === TAKEN ? 'taken' : 'missed';
  let medication = null;

  try {
    medication = await persistMedicationUpdate(actor, session.medicationId, {
      status: medicationStatus,
      statusSource: 'voice'
    });
  } catch (error) {
    console.error('voice_medication_update_failed', { sessionId: session.id });
  }

  const event = outcomeEvent(outcome, reason);
  const detail = `${session.medicationName || session.medicationId} · scheduled ${scheduleLabel(session.medicationSchedule || '00:00')} · ${reason}`;

  await persistEvent(actor, {
    at: new Date().toISOString(),
    title: event.title,
    actor: 'CarePulse Voice Agent',
    type: event.type,
    detail,
    recipientId: session.recipientId
  });

  await createVoiceCallRecord(session.recipientId, {
    sessionId: session.id,
    callSid: session.callSid || null,
    status: 'completed',
    completedAt: new Date().toISOString(),
    attempt,
    outcome,
    reason,
    provider: session.provider === 'twilio' && session.callSid ? 'twilio' : 'simulator'
  });

  if (outcome !== TAKEN && config.voiceAutoEscalate) {
    try {
      await sendReminder({
        user: actor,
        to: config.careTeamAlertEmails,
        subject: `CareMesh alert · AI voice check-in needs caregiver attention: ${session.medicationName || session.medicationId}`,
        text: [
          'CareMesh AI voice check-in needs caregiver attention.',
          '',
          `Medication: ${session.medicationName || session.medicationId}`,
          `Scheduled: ${scheduleLabel(session.medicationSchedule || '00:00')}`,
          `Outcome: ${outcome}`,
          `Reason: ${reason}`,
          '',
          'The elder did not confirm this dose through the automated check-in.',
          'CareMesh records whether the scheduled medication was confirmed. It does not verify ingestion.',
          '',
          'This automated message was sent by CareMesh CarePulse.'
        ].join('\n'),
        kind: 'voice-escalation',
        key: `voice-escalation:${session.id}`
      });
    } catch (error) {
      console.error('voice_escalation_email_failed', { sessionId: session.id });
    }
  }

  await updateVoiceSession(session.id, {
    status: 'completed',
    outcome,
    reason,
    callSid: session.callSid || null,
    completedAt: new Date().toISOString()
  });

  return {
    status: 'completed',
    outcome,
    reason,
    sessionId: session.id,
    medicationId: session.medicationId,
    medicationStatus,
    escalated: outcome !== TAKEN && config.voiceAutoEscalate,
    medication
  };
}

function sayTag(text, language) {
  const attrs = language === 'en-IN' || language === 'hi-IN'
    ? `language="${language}" voice="Polly.Aditi"`
    : 'language="en-US" voice="Polly.Joanna"';
  return `<Say ${attrs}>${escapeXml(text)}</Say>`;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twiml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

function unavailableTwiml(language) {
  return twiml(`${sayTag('This CareMesh check-in is no longer available. Goodbye.', language)}<Hangup/>`);
}

function startPrompt(session) {
  const name = session.displayName || 'there';
  return `Hi ${name}, this is CareMesh CarePulse. Your ${session.medicationName || 'scheduled medication'} dose scheduled for ${scheduleLabel(session.medicationSchedule || '00:00')} is not yet confirmed. Have you taken it? You can say yes, no, or I need help.`;
}

function retryPrompt() {
  return 'Sorry, I did not understand. Please say yes if you have taken the medicine, no if you have not, or I need help if you want your caregiver to follow up.';
}

function gatherTwiml(session, prompt) {
  const action = `/api/voice/twiml/response?session=${encodeURIComponent(session.id)}`;
  return twiml(
    `${sayTag(prompt, session.language)}` +
    `<Gather action="${action}" method="POST" input="speech dtmf" numDigits="1" speechTimeout="auto" timeout="8" actionOnEmptyResult="true">` +
    `${sayTag('Press 1 if you took it, 2 if you did not, or 3 if you need help.', session.language)}` +
    '</Gather>' +
    `${sayTag('I did not receive a response. Goodbye.', session.language)}<Hangup/>`
  );
}

export async function twimlStart(sessionId) {
  const session = await getVoiceSession(sessionId);
  if (!session) return unavailableTwiml(config.voiceLanguage);
  if (session.status === 'completed' || ['processing'].includes(session.status)) {
    return unavailableTwiml(session.language);
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await updateVoiceSession(session.id, { status: 'expired' });
    return unavailableTwiml(session.language);
  }
  await updateVoiceSession(session.id, { status: 'active' });
  return gatherTwiml(session, startPrompt(session));
}

export async function twimlResponse(sessionId, { speech, digits } = {}) {
  const claimed = await claimVoiceSession(sessionId);
  if (!claimed) return unavailableTwiml(config.voiceLanguage);

  const input = digits || speech || '';
  const { intent } = classifyVoiceIntent(input);
  const attempt = Number(claimed.attempt || 1);

  if (intent === 'TAKEN') {
    await applyOutcome(claimed, { outcome: TAKEN, reason: 'Elder confirmed the medication through the voice check-in', attempt });
    return twiml(`${sayTag('Thank you. I have recorded that your medication was confirmed. Goodbye.', claimed.language)}<Hangup/>`);
  }

  if (intent === 'NOT_TAKEN') {
    await applyOutcome(claimed, { outcome: 'missed', reason: OUTCOME_REASONS.missed, attempt });
    return twiml(`${sayTag('Okay. I have recorded that this dose is not taken and notified your care circle. A caregiver can follow up with you. Goodbye.', claimed.language)}<Hangup/>`);
  }

  if (intent === 'HELP') {
    await applyOutcome(claimed, { outcome: 'help_requested', reason: OUTCOME_REASONS.help_requested, attempt });
    return twiml(`${sayTag('Okay. I have recorded this in CareMesh and notified your care circle. A caregiver can follow up with you. Goodbye.', claimed.language)}<Hangup/>`);
  }

  if (attempt < config.voiceMaxAttempts) {
    await updateVoiceSession(claimed.id, { status: 'active', attempt: attempt + 1 });
    return gatherTwiml({ ...claimed, attempt: attempt + 1 }, retryPrompt());
  }

  await applyOutcome(claimed, { outcome: 'unclear', reason: OUTCOME_REASONS.unclear, attempt });
  return twiml(`${sayTag('I was not able to understand a response. I have recorded this and notified your care circle. A caregiver can follow up with you. Goodbye.', claimed.language)}<Hangup/>`);
}

// Twilio status callbacks. A call that is never answered must not loop forever:
// one retry, then caregiver escalation.
export async function handleVoiceStatus({ sessionId, callStatus }) {
  const session = await getVoiceSession(sessionId);
  if (!session || session.status === 'completed') return { status: 'ignored' };

  const status = String(callStatus || '').toLowerCase();
  const failureMap = { busy: 'busy', 'no-answer': 'no_answer', failed: 'failed', canceled: 'canceled' };
  const outcome = status === 'completed' ? 'no_answer' : failureMap[status];
  if (!outcome) return { status: 'ignored' };

  const claimed = await claimVoiceSession(sessionId);
  if (!claimed) return { status: 'ignored' };

  const attempt = Number(claimed.attempt || 1);
  if (attempt < config.voiceMaxAttempts) {
    await updateVoiceSession(claimed.id, { status: 'retrying', attempt: attempt + 1 });
    const retry = await initiateCall(claimed, attempt + 1);
    if (retry.ok) return { status: 'retrying', sessionId: claimed.id };
    await applyOutcome(claimed, { outcome: retry.reason === 'caller_id_not_supported' ? 'failed' : 'no_answer', reason: OUTCOME_REASONS[status === 'completed' ? 'no_answer' : outcome] || OUTCOME_REASONS.failed, attempt: attempt + 1 });
    return { status: 'escalated', sessionId: claimed.id };
  }

  const reason = status === 'completed' ? 'Call ended without a response' : OUTCOME_REASONS[outcome];
  await applyOutcome(claimed, { outcome, reason, attempt });
  return { status: 'escalated', sessionId: claimed.id };
}

// Simulator for judges. Uses the same session and outcome pipeline as a real
// call, so what judges see is what production does.
export async function simulateVoiceCheckIn({ user, medicationId, response, sessionId = null }) {
  const recipientId = recipientIdFor(user);
  if (!recipientId) return { status: 'error', message: 'No care recipient is assigned to this account.' };

  let session = sessionId ? await getVoiceSession(sessionId) : null;
  if (session && session.recipientId !== recipientId) {
    return { status: 'forbidden', message: 'This voice check-in does not belong to your care circle.' };
  }

  if (!session) {
    const medication = await findMedication(user, medicationId);
    if (!medication) return { status: 'not_found', message: 'Medication not found.' };
    session = await createVoiceSession(buildSession({
      target: { recipientId, phoneMasked: '', language: config.voiceLanguage },
      medication
    }));
  }

  const claimed = await claimVoiceSession(session.id);
  if (!claimed) {
    return { status: 'expired', message: 'This voice check-in has already been completed or has expired.' };
  }

  const attempt = Number(claimed.attempt || 1);

  if (response === 'taken') {
    return applyOutcome(claimed, { outcome: TAKEN, reason: 'Elder confirmed the medication through the voice check-in', attempt });
  }
  if (response === 'not-taken') {
    return applyOutcome(claimed, { outcome: 'missed', reason: OUTCOME_REASONS.missed, attempt });
  }
  if (response === 'help') {
    return applyOutcome(claimed, { outcome: 'help_requested', reason: OUTCOME_REASONS.help_requested, attempt });
  }
  if (response === 'no-answer') {
    return applyOutcome(claimed, { outcome: 'no_answer', reason: OUTCOME_REASONS.no_answer, attempt });
  }
  if (response === 'unclear') {
    if (attempt < config.voiceMaxAttempts) {
      await updateVoiceSession(claimed.id, { status: 'active', attempt: attempt + 1 });
      return {
        status: 'retry',
        attempt: attempt + 1,
        sessionId: claimed.id,
        message: 'The elder did not respond clearly. The agent will ask once more.'
      };
    }
    return applyOutcome(claimed, { outcome: 'unclear', reason: OUTCOME_REASONS.unclear, attempt });
  }

  await updateVoiceSession(claimed.id, { status: 'active' });
  return { status: 'error', message: 'Unsupported simulator response.' };
}

export async function getSessionForUser(user, sessionId) {
  const session = await getVoiceSession(sessionId);
  if (!session) return null;
  if (session.recipientId !== recipientIdFor(user)) return null;
  const { toMasked, ...safe } = session;
  return { ...safe, phone: toMasked || null };
}
