import test from 'node:test';
import assert from 'node:assert/strict';

// Configure a voice-enabled runtime before the server module freezes config.
process.env.CARE_VOICE_ENABLED = 'true';
process.env.CARE_VOICE_PROVIDER = 'twilio';
process.env.TWILIO_ACCOUNT_SID = 'ACtest00000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_FROM_NUMBER = '+15005550006';
process.env.CARE_VOICE_PHONE = '+919999999999';
process.env.CARE_VOICE_LANGUAGE = 'en-IN';
process.env.CARE_VOICE_MAX_ATTEMPTS = '2';
process.env.CARE_VOICE_AUTO_ESCALATE = 'true';

const twilio = (await import('twilio')).default;
const { createHandler } = await import('../server.mjs');
const store = await import('../src/store.mjs');
const data = await import('../src/data.mjs');
const { createSession } = await import('../src/security.mjs');
const { classifyVoiceIntent } = await import('../src/voice-intent.mjs');

const handler = createHandler();
const AUTH_TOKEN = 'test-auth-token';
const SESSION_SECRET = 'test-session-secret';
const DEMO_RECIPIENT = 'demo-recipient';

function cookieFor(userId) {
  return `caremesh_session=${createSession(userId, SESSION_SECRET)}`;
}

const elderCookie = cookieFor('usr-elder');
const caregiverCookie = cookieFor('usr-caregiver');
const familyCookie = cookieFor('usr-family');

function makeRes() {
  const chunks = [];
  let status = 200;
  let headers = {};
  return {
    writeHead(code, extra) { status = code; headers = extra || {}; },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); },
    get statusCode() { return status; },
    get headers() { return headers; },
    get text() { return Buffer.concat(chunks).toString('utf8'); },
    get json() { try { return JSON.parse(this.text); } catch { return {}; } }
  };
}

function makeReq({ method = 'GET', url = '/', headers = {}, bodyText = '' } = {}) {
  const chunks = bodyText ? [Buffer.from(bodyText)] : [];
  return {
    method,
    url,
    headers: { host: 'localhost', ...headers },
    socket: { remoteAddress: '198.51.100.20' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  };
}

async function call({ method = 'GET', path, json, form, cookie, headers = {} }) {
  const bodyText = json !== undefined
    ? JSON.stringify(json)
    : (form ? new URLSearchParams(form).toString() : '');
  const requestHeaders = {
    ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    ...(cookie ? { cookie } : {}),
    ...headers
  };
  const req = makeReq({ method, url: path, headers: requestHeaders, bodyText });
  const res = makeRes();
  await handler(req, res);
  return res;
}

function signedCall(path, params, { signature, includeSignature = true } = {}) {
  const url = `http://localhost${path}`;
  const computed = signature ?? twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return call({
    method: 'POST',
    path,
    form: params,
    headers: includeSignature ? { 'x-twilio-signature': computed } : {}
  });
}

async function dashboard(cookie) {
  const res = await call({ path: '/api/dashboard', cookie });
  assert.equal(res.statusCode, 200);
  return res.json;
}

function resetDemo() {
  const state = data.getState();
  state.medications.find((item) => item.id === 'med-3').status = 'pending';
  state.events.length = 0;
  state.outbox.length = 0;
  state.reminders.length = 0;
  store.resetVoiceState();
}

async function demoSession(medicationId = 'med-3') {
  return store.createVoiceSession({
    id: `sess-${Math.random().toString(36).slice(2)}`,
    recipientId: DEMO_RECIPIENT,
    medicationId,
    medicationName: 'Vitamin D3 1000 IU',
    medicationSchedule: '20:00',
    status: 'pending',
    attempt: 1,
    language: 'en-IN',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
}

// --- Intent classification -------------------------------------------------

test('voice intent recognises natural confirmations', () => {
  for (const phrase of ['yes', 'yes I took it', 'I already took it', 'taken', '1']) {
    assert.equal(classifyVoiceIntent(phrase).intent, 'TAKEN', phrase);
  }
});

test('voice intent recognises negative answers without reading them as taken', () => {
  for (const phrase of ['no', 'I forgot', 'not yet', "I haven't taken it", 'I have not taken it', '2']) {
    assert.equal(classifyVoiceIntent(phrase).intent, 'NOT_TAKEN', phrase);
  }
});

test('voice intent recognises help requests before negative words', () => {
  for (const phrase of ['I need help', 'please call me', '3']) {
    assert.equal(classifyVoiceIntent(phrase).intent, 'HELP', phrase);
  }
});

test('voice intent keeps ambiguous answers unclear', () => {
  for (const phrase of ['blah blah', '', 'I don\'t know']) {
    assert.equal(classifyVoiceIntent(phrase).intent, 'UNCLEAR', phrase);
  }
});

// --- Simulator state machine ----------------------------------------------

test('simulator confirms a pending dose and does not escalate', async () => {
  resetDemo();
  const res = await call({
    method: 'POST',
    path: '/api/voice/demo',
    cookie: elderCookie,
    json: { medicationId: 'med-3', response: 'taken' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.outcome, 'taken');
  assert.equal(res.json.escalated, false);

  const board = await dashboard(elderCookie);
  assert.equal(board.medications.find((item) => item.id === 'med-3').status, 'taken');
  const event = board.events.find((item) => item.title === 'Medication confirmed by AI voice check-in');
  assert.ok(event, 'confirmation event recorded');
  assert.equal(event.actor, 'CarePulse Voice Agent');
  assert.equal(board.outbox.filter((item) => item.kind === 'voice-escalation').length, 0);
});

test('simulator keeps a missed dose missed and escalates to the caregiver', async () => {
  resetDemo();
  const res = await call({
    method: 'POST',
    path: '/api/voice/demo',
    cookie: caregiverCookie,
    json: { medicationId: 'med-3', response: 'not-taken' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.outcome, 'missed');
  assert.equal(res.json.escalated, true);

  const board = await dashboard(caregiverCookie);
  assert.equal(board.medications.find((item) => item.id === 'med-3').status, 'missed');
  assert.ok(board.events.some((item) => item.title === 'AI voice check-in escalated to caregiver'));
  assert.ok(board.outbox.some((item) => item.kind === 'voice-escalation'));
});

test('simulator escalates a help request', async () => {
  resetDemo();
  const res = await call({
    method: 'POST',
    path: '/api/voice/demo',
    cookie: elderCookie,
    json: { medicationId: 'med-3', response: 'help' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.outcome, 'help_requested');
  const board = await dashboard(elderCookie);
  assert.ok(board.events.some((item) => item.title === 'AI voice check-in escalated to caregiver'));
});

test('simulator asks once more, then escalates an unclear answer', async () => {
  resetDemo();
  const first = await call({
    method: 'POST',
    path: '/api/voice/demo',
    cookie: elderCookie,
    json: { medicationId: 'med-3', response: 'unclear' }
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json.status, 'retry');
  assert.equal(first.json.attempt, 2);

  const second = await call({
    method: 'POST',
    path: '/api/voice/demo',
    cookie: elderCookie,
    json: { medicationId: 'med-3', response: 'unclear', sessionId: first.json.sessionId }
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json.outcome, 'unclear');
  assert.equal(second.json.escalated, true);
});

test('simulator escalates a call that was never answered', async () => {
  resetDemo();
  const res = await call({
    method: 'POST',
    path: '/api/voice/demo',
    cookie: elderCookie,
    json: { medicationId: 'med-3', response: 'no-answer' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.outcome, 'no_answer');
  const board = await dashboard(elderCookie);
  assert.ok(board.events.some((item) => item.title === 'AI voice call could not complete'));
});

// --- Authorization ---------------------------------------------------------

test('family role cannot trigger a voice check-in or simulator', async () => {
  resetDemo();
  const sim = await call({
    method: 'POST',
    path: '/api/voice/demo',
    cookie: familyCookie,
    json: { medicationId: 'med-3', response: 'taken' }
  });
  assert.equal(sim.statusCode, 403);

  const checkIn = await call({
    method: 'POST',
    path: '/api/voice/check-in',
    cookie: familyCookie,
    json: { medicationId: 'med-3', mode: 'prepare' }
  });
  assert.equal(checkIn.statusCode, 403);
});

test('only a caregiver can place a real voice call', async () => {
  resetDemo();
  const elder = await call({
    method: 'POST',
    path: '/api/voice/check-in',
    cookie: elderCookie,
    json: { medicationId: 'med-3', mode: 'prepare' }
  });
  assert.equal(elder.statusCode, 403);
  assert.match(elder.json.error, /caregiver/i);
});

test('voice routes reject unauthenticated requests', async () => {
  const res = await call({ method: 'POST', path: '/api/voice/check-in', json: { medicationId: 'med-3' } });
  assert.equal(res.statusCode, 401);
});

test('a voice session cannot be driven by another care circle', async () => {
  resetDemo();
  const foreign = await store.createVoiceSession({
    id: 'sess-foreign',
    recipientId: 'other-recipient',
    medicationId: 'med-3',
    medicationName: 'Foreign medication',
    medicationSchedule: '09:00',
    status: 'pending',
    attempt: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });

  const res = await call({
    method: 'POST',
    path: '/api/voice/demo',
    cookie: elderCookie,
    json: { medicationId: 'med-3', response: 'taken', sessionId: foreign.id }
  });
  assert.equal(res.statusCode, 403);

  const status = await call({ path: `/api/voice/status/${foreign.id}`, cookie: elderCookie });
  assert.equal(status.statusCode, 404);
});

test('simulator rejects an unknown medication', async () => {
  const res = await call({
    method: 'POST',
    path: '/api/voice/demo',
    cookie: elderCookie,
    json: { medicationId: 'med-missing', response: 'taken' }
  });
  assert.equal(res.statusCode, 404);
});

// --- Twilio webhooks -------------------------------------------------------

test('webhook rejects a missing signature', async () => {
  resetDemo();
  const session = await demoSession();
  const res = await signedCall(`/api/voice/twiml/start?session=${session.id}`, { CallSid: 'CA1' }, { includeSignature: false });
  assert.equal(res.statusCode, 403);
});

test('webhook rejects an invalid signature', async () => {
  resetDemo();
  const session = await demoSession();
  const res = await signedCall(`/api/voice/twiml/start?session=${session.id}`, { CallSid: 'CA1' }, { signature: 'not-a-signature' });
  assert.equal(res.statusCode, 403);
});

test('a valid signed webhook returns TwiML with no recipient ids in the URL', async () => {
  resetDemo();
  const session = await demoSession();
  const res = await signedCall(`/api/voice/twiml/start?session=${session.id}`, { CallSid: 'CA1' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/xml/);
  assert.match(res.text, /<Gather/);
  assert.match(res.text, /Vitamin D3 1000 IU/);
  assert.match(res.text, new RegExp(`session=${session.id}`));
  assert.doesNotMatch(res.text, /demo-recipient/);
  assert.doesNotMatch(res.text, /med-3/);
});

test('a signed TAKEN response updates the medication and records one event', async () => {
  resetDemo();
  const session = await demoSession();
  const res = await signedCall(`/api/voice/twiml/response?session=${session.id}`, {
    CallSid: 'CA1',
    SpeechResult: 'yes I took it'
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.text, /recorded/i);

  const board = await dashboard(elderCookie);
  assert.equal(board.medications.find((item) => item.id === 'med-3').status, 'taken');
  const voiced = board.events.filter((item) => item.actor === 'CarePulse Voice Agent');
  assert.equal(voiced.length, 1);
  assert.equal(voiced[0].title, 'Medication confirmed by AI voice check-in');
});

test('DTMF 3 escalates to the caregiver', async () => {
  resetDemo();
  const session = await demoSession();
  const res = await signedCall(`/api/voice/twiml/response?session=${session.id}`, { CallSid: 'CA2', Digits: '3' });
  assert.equal(res.statusCode, 200);
  const board = await dashboard(elderCookie);
  assert.equal(board.medications.find((item) => item.id === 'med-3').status, 'missed');
  assert.ok(board.events.some((item) => item.title === 'AI voice check-in escalated to caregiver'));
});

test('a replayed webhook cannot mutate medication state twice', async () => {
  resetDemo();
  const session = await demoSession();
  const params = { CallSid: 'CA3', SpeechResult: 'yes took it' };
  await signedCall(`/api/voice/twiml/response?session=${session.id}`, params);
  const replay = await signedCall(`/api/voice/twiml/response?session=${session.id}`, params);
  assert.equal(replay.statusCode, 200);
  assert.match(replay.text, /no longer available/i);

  const board = await dashboard(elderCookie);
  assert.equal(board.medications.find((item) => item.id === 'med-3').status, 'taken');
  assert.equal(board.events.filter((item) => item.actor === 'CarePulse Voice Agent').length, 1);
  assert.equal(store.voiceCallHistory().filter((call) => call.sessionId === session.id).length, 1);
});

test('an expired session cannot mutate medication state', async () => {
  resetDemo();
  const session = await store.createVoiceSession({
    id: 'sess-expired',
    recipientId: DEMO_RECIPIENT,
    medicationId: 'med-3',
    medicationName: 'Vitamin D3 1000 IU',
    medicationSchedule: '20:00',
    status: 'active',
    attempt: 1,
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  const res = await signedCall(`/api/voice/twiml/response?session=${session.id}`, { CallSid: 'CA4', SpeechResult: 'yes' });
  assert.equal(res.statusCode, 200);
  assert.match(res.text, /no longer available/i);

  const board = await dashboard(elderCookie);
  assert.equal(board.medications.find((item) => item.id === 'med-3').status, 'pending');
  assert.equal((await store.getVoiceSession(session.id)).status, 'expired');
});

test('status callback escalates after the final failed attempt', async () => {
  resetDemo();
  const session = await store.createVoiceSession({
    id: 'sess-failed-call',
    recipientId: DEMO_RECIPIENT,
    medicationId: 'med-3',
    medicationName: 'Vitamin D3 1000 IU',
    medicationSchedule: '20:00',
    status: 'calling',
    attempt: 2,
    callSid: 'CA5',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const res = await signedCall(`/api/voice/status?session=${session.id}`, { CallSid: 'CA5', CallStatus: 'no-answer' });
  assert.equal(res.statusCode, 200);

  const board = await dashboard(elderCookie);
  assert.ok(board.events.some((item) => item.title === 'AI voice call could not complete'));
  assert.ok(board.outbox.some((item) => item.kind === 'voice-escalation'));
});

// --- Idempotency and provider fallback ------------------------------------

test('the same missed dose can only be claimed once', async () => {
  resetDemo();
  const key = 'medication-missed:2026-11-17:med-3';
  const user = { source: 'local' };
  assert.equal(await store.claimReminder(user, { key, kind: 'voice-check-in', status: 'voice-queued' }), true);
  assert.equal(await store.claimReminder(user, { key, kind: 'voice-check-in', status: 'voice-queued' }), false);
  await store.releaseReminder(user, key);
  assert.equal(await store.claimReminder(user, { key, kind: 'voice-check-in', status: 'voice-queued' }), true);
});

test('voice status endpoint reports configuration without leaking secrets', async () => {
  const res = await call({ path: '/api/voice', cookie: elderCookie });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ready, true);
  assert.equal(res.json.provider, 'twilio');
  const serialised = JSON.stringify(res.json);
  assert.doesNotMatch(serialised, /test-auth-token/);
  assert.doesNotMatch(serialised, /9999999999/);
});

test('preparing a check-in stores an expiring opaque session, not a phone number', async () => {
  resetDemo();
  const res = await call({
    method: 'POST',
    path: '/api/voice/check-in',
    cookie: caregiverCookie,
    json: { medicationId: 'med-3', mode: 'prepare' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.status, 'prepared');
  const session = await store.getVoiceSession(res.json.sessionId);
  assert.ok(session);
  assert.ok(new Date(session.expiresAt).getTime() > Date.now());
  assert.equal(session.recipientId, DEMO_RECIPIENT);
  assert.equal(session.toMasked, '****9999');
  assert.doesNotMatch(JSON.stringify(session), /9999999999/);
});
