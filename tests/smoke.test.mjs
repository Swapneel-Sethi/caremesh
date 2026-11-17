import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { clockLabel } from '../src/time.mjs';

const port = 8123;
const cronSecret = 'test-cron-secret';
let child;
let cookie = '';
let familyCookie = '';
let caregiverCookie = '';

async function request(path, options = {}) {
  const headers = {
    ...(options.body ? {'content-type':'application/json'} : {}),
    'origin': `http://127.0.0.1:${port}`,
    'referer': `http://127.0.0.1:${port}/`,
    ...(options.headers || {})
  };
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  const setCookie = response.headers.get('set-cookie');
  return { response, body, setCookie };
}

before(async () => {
  const { VERCEL, ...env } = process.env;
  child = spawn(process.execPath, ['server.mjs'], {
    env: {
      ...env,
      PORT: String(port),
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret',
      CRON_SECRET: cronSecret,
      RESEND_API_KEY: '',
      CARE_TEAM_ALERT_EMAILS: '',
      GOOGLE_CLOUD_PROJECT: '',
      USE_FIRESTORE: 'false',
      APP_ORIGIN: `http://127.0.0.1:${port}`
    },
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try { const { response } = await request('/api/health'); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start');
});

after(() => child?.kill('SIGTERM'));

test('health endpoint exposes runtime mode', async () => {
  const { response, body } = await request('/api/health');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.cron, 'configured');
});

test('elder login and dashboard work end to end', async () => {
  const login = await request('/api/auth/login', { method:'POST', body: JSON.stringify({ role:'elder', passcode:'1234' }) });
  assert.equal(login.response.status, 200);
  cookie = login.setCookie.split(';')[0];
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /SameSite=Lax/);
  const dashboard = await request('/api/dashboard', { headers: { cookie } });
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.body.profile.name, 'Meera Rao');
  assert.ok(Array.isArray(dashboard.body.medications));
  assert.ok(dashboard.body.events.length > 0);
  assert.ok(dashboard.body.careTeam.length > 0);
  assert.ok(Array.isArray(dashboard.body.appointments));
});

test('caregiver login and dashboard work end to end', async () => {
  const login = await request('/api/auth/login', { method:'POST', body: JSON.stringify({ role:'caregiver', passcode:'2468' }) });
  assert.equal(login.response.status, 200);
  const caregiverCookie = login.setCookie.split(';')[0];
  const dashboard = await request('/api/dashboard', { headers: { cookie: caregiverCookie } });
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.body.profile.name, 'Meera Rao');
  assert.ok(Array.isArray(dashboard.body.medications));
  assert.ok(dashboard.body.careTeam.length > 0);
  assert.ok(Array.isArray(dashboard.body.appointments));
});

test('family login and dashboard work end to end', async () => {
  const login = await request('/api/auth/login', { method:'POST', body: JSON.stringify({ role:'family', passcode:'1357' }) });
  assert.equal(login.response.status, 200);
  const familyCookie = login.setCookie.split(';')[0];
  const dashboard = await request('/api/dashboard', { headers: { cookie: familyCookie } });
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.body.profile.name, 'Meera Rao');
  assert.ok(Array.isArray(dashboard.body.medications));
  assert.ok(dashboard.body.careTeam.length > 0);
  assert.ok(Array.isArray(dashboard.body.appointments));
});

test('family session cannot mutate medications or trigger reminders', async () => {
  const login = await request('/api/auth/login', { method:'POST', body: JSON.stringify({ role:'family', passcode:'1357' }) });
  assert.equal(login.response.status, 200);
  familyCookie = login.setCookie.split(';')[0];
  const write = await request('/api/medications', { method:'POST', headers:{cookie:familyCookie}, body:JSON.stringify({name:'Blocked', schedule:'17:00'}) });
  assert.equal(write.response.status, 403);
  const reminder = await request('/api/reminders/run', { method:'POST', headers:{cookie:familyCookie}, body:'{}' });
  assert.equal(reminder.response.status, 403);
});

test('caregiver can access reminders but family cannot add appointments', async () => {
  const login = await request('/api/auth/login', { method:'POST', body: JSON.stringify({ role:'caregiver', passcode:'2468' }) });
  assert.equal(login.response.status, 200);
  caregiverCookie = login.setCookie.split(';')[0];
  const preview = await request('/api/reminders/preview', { method:'POST', headers:{cookie:caregiverCookie}, body:'{}' });
  assert.equal(preview.response.status, 200);
  const appointment = await request('/api/appointments', { method:'POST', headers:{cookie:familyCookie}, body:JSON.stringify({ doctor:'Blocked', specialty:'QA', date:'2026-12-01', time:'10:00', location:'QA' }) });
  assert.equal(appointment.response.status, 403);
});

test('protected endpoints reject unauthenticated requests', async () => {
  const dashboard = await request('/api/dashboard');
  assert.equal(dashboard.response.status, 401);
  const reminder = await request('/api/reminders/run', { method:'POST', body:'{}' });
  assert.equal(reminder.response.status, 401);
  const preview = await request('/api/reminders/preview', { method:'POST', body:'{}' });
  assert.equal(preview.response.status, 401);
});

test('malformed input is rejected with 400 rather than 500', async () => {
  const badMedication = await request('/api/medications', { method:'POST', headers:{cookie}, body:JSON.stringify({ name:'Bad medicine', schedule:'25:99' }) });
  assert.equal(badMedication.response.status, 400);
  const badAppointment = await request('/api/appointments', { method:'POST', headers:{cookie}, body:JSON.stringify({ doctor:'Dr. Bad', date:'tomorrow', time:'10:00' }) });
  assert.equal(badAppointment.response.status, 400);
  const malformed = await request('/api/medications', { method:'POST', headers:{cookie}, body:'{not json' });
  assert.equal(malformed.response.status, 400);
  const nullBody = await request('/api/appointments', { method:'POST', headers:{cookie}, body:'null' });
  assert.equal(nullBody.response.status, 400);
});

test('upcoming medication reminder is generated once, then deduplicated', async () => {
  const schedule = clockLabel(new Date());
  const created = await request('/api/medications', { method:'POST', headers:{cookie}, body:JSON.stringify({ name:'QA Reminder Test 10 mg', schedule, instructions:'QA only' }) });
  assert.equal(created.response.status, 201);
  const medicationId = created.body.medication.id;

  const first = await request('/api/reminders/run', { method:'POST', headers:{cookie}, body:'{}' });
  assert.equal(first.response.status, 200);
  const firstRun = first.body.results.find((item) => item.medicationId === medicationId);
  assert.ok(firstRun, 'expected the new medication in the reminder results');
  assert.equal(firstRun.status, 'preview');

  const second = await request('/api/reminders/run', { method:'POST', headers:{cookie}, body:'{}' });
  assert.equal(second.response.status, 200);
  const secondRun = second.body.results.find((item) => item.medicationId === medicationId);
  assert.ok(secondRun, 'expected the duplicate key to be reported');
  assert.equal(secondRun.status, 'duplicate');
});

test('dashboard outbox is sanitized and reminders appear in event history', async () => {
  const dashboard = await request('/api/dashboard', { headers: { cookie } });
  assert.equal(dashboard.response.status, 200);
  assert.ok(dashboard.body.outbox.length > 0);
  for (const item of dashboard.body.outbox) {
    assert.equal('to' in item, false);
    assert.equal('text' in item, false);
    assert.equal('recipientCount' in item, false);
  }
  assert.doesNotMatch(JSON.stringify(dashboard.body.outbox), /@/);
  assert.ok(dashboard.body.events.some((event) => event.type === 'reminder'));
});

test('cron endpoint rejects missing or wrong secrets and accepts the configured secret', async () => {
  const anonymous = await request('/api/cron/reminders');
  assert.equal(anonymous.response.status, 401);
  const wrong = await request('/api/cron/reminders', { headers: { authorization: 'Bearer wrong-secret' } });
  assert.equal(wrong.response.status, 401);
  const authorized = await request('/api/cron/reminders', { headers: { authorization: `Bearer ${cronSecret}` } });
  assert.equal(authorized.response.status, 200);
  assert.equal(authorized.body.ok, true);
  assert.ok(Array.isArray(authorized.body.results));
});

test('logout clears the session cookie', async () => {
  const logout = await request('/api/auth/logout', { method:'POST', headers:{cookie}, body:'{}' });
  assert.equal(logout.response.status, 200);
  assert.match(logout.setCookie, /Max-Age=0/);
  assert.match(logout.setCookie, /HttpOnly/);
});

test('unknown API routes return 404', async () => {
  const unknown = await request('/api/not-a-route', { headers: { cookie } });
  assert.equal(unknown.response.status, 404);
});
