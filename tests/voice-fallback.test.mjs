import test from 'node:test';
import assert from 'node:assert/strict';

// A deployment without Twilio credentials must still boot, serve the dashboard
// and run the judge simulator. This suite asserts the graceful fallback.
delete process.env.CARE_VOICE_ENABLED;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.CARE_VOICE_PHONE;
delete process.env.RESEND_API_KEY;
delete process.env.GOOGLE_CLOUD_PROJECT;

const { createHandler } = await import('../server.mjs');
const store = await import('../src/store.mjs');
const data = await import('../src/data.mjs');
const { createSession } = await import('../src/security.mjs');

const handler = createHandler();
const SESSION_SECRET = 'test-session-secret';

function cookieFor(userId) {
  return `caremesh_session=${createSession(userId, SESSION_SECRET)}`;
}

const elderCookie = cookieFor('usr-elder');
const caregiverCookie = cookieFor('usr-caregiver');

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
    socket: { remoteAddress: '198.51.100.21' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  };
}

async function call({ method = 'GET', path, json, cookie }) {
  const bodyText = json !== undefined ? JSON.stringify(json) : '';
  const req = makeReq({
    method,
    url: path,
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {})
    },
    bodyText
  });
  const res = makeRes();
  await handler(req, res);
  return res;
}

function resetDemo() {
  const state = data.getState();
  state.medications.find((item) => item.id === 'med-3').status = 'pending';
  state.events.length = 0;
  state.outbox.length = 0;
  state.reminders.length = 0;
  store.resetVoiceState();
}

test('health and voice status report an unconfigured provider instead of failing', async () => {
  const health = await call({ path: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json.voice, 'unconfigured');

  const voice = await call({ path: '/api/voice', cookie: elderCookie });
  assert.equal(voice.statusCode, 200);
  assert.equal(voice.json.ready, false);
  assert.equal(voice.json.provider, 'simulator');
});

test('dashboard still loads when voice calling is not configured', async () => {
  const res = await call({ path: '/api/dashboard', cookie: elderCookie });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.profile.name, 'Meera Rao');
  assert.ok(Array.isArray(res.json.medications));
});

test('a real voice check-in is refused with a clear setup message', async () => {
  resetDemo();
  const res = await call({
    method: 'POST',
    path: '/api/voice/check-in',
    cookie: caregiverCookie,
    json: { medicationId: 'med-3', mode: 'call' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.status, 'unavailable');
  assert.equal(res.json.reason, 'not_configured');
  assert.match(res.json.message, /not configured/i);

  const board = await call({ path: '/api/dashboard', cookie: caregiverCookie });
  assert.equal(board.json.medications.find((item) => item.id === 'med-3').status, 'pending');
  assert.equal(store.voiceCallHistory().length, 0);
});

test('the demo simulator runs the full workflow without Twilio', async () => {
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

  const board = await call({ path: '/api/dashboard', cookie: caregiverCookie });
  assert.equal(board.json.medications.find((item) => item.id === 'med-3').status, 'missed');
  assert.ok(board.json.events.some((item) => item.actor === 'CarePulse Voice Agent'));
  assert.ok(board.json.outbox.some((item) => item.kind === 'voice-escalation'));

  const calls = store.voiceCallHistory();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'simulator');
});

test('simulator confirmation works with no provider credentials present', async () => {
  resetDemo();
  const res = await call({
    method: 'POST',
    path: '/api/voice/demo',
    cookie: elderCookie,
    json: { medicationId: 'med-3', response: 'taken' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.outcome, 'taken');

  const board = await call({ path: '/api/dashboard', cookie: elderCookie });
  assert.equal(board.json.medications.find((item) => item.id === 'med-3').status, 'taken');
  assert.equal(board.json.outbox.filter((item) => item.kind === 'voice-escalation').length, 0);
});

test('unconfigured runtime never echoes provider secrets or phone numbers', async () => {
  resetDemo();
  const payloads = [];
  payloads.push((await call({ path: '/api/health' })).text);
  payloads.push((await call({ path: '/api/voice', cookie: elderCookie })).text);
  payloads.push((await call({
    method: 'POST',
    path: '/api/voice/demo',
    cookie: elderCookie,
    json: { medicationId: 'med-3', response: 'taken' }
  })).text);
  const serialised = payloads.join('\n');
  assert.doesNotMatch(serialised, /ACtest/);
  assert.doesNotMatch(serialised, /TWILIO_AUTH_TOKEN/);
  assert.doesNotMatch(serialised, /\+91/);
});
