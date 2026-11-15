import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 8123;
let child;
let cookie = '';
let familyCookie = '';

async function request(path, options = {}) {
  const headers = { ...(options.body ? {'content-type':'application/json'} : {}), ...(options.headers || {}) };
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  const setCookie = response.headers.get('set-cookie');
  return { response, body, setCookie };
}

before(async () => {
  child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), NODE_ENV: 'test' }, stdio: 'ignore' });
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
});

test('elder login and dashboard work end-to-end', async () => {
  const login = await request('/api/auth/login', { method:'POST', body: JSON.stringify({ role:'elder', passcode:'1234' }) });
  assert.equal(login.response.status, 200);
  cookie = login.setCookie.split(';')[0];
  const dashboard = await request('/api/dashboard', { headers: { cookie } });
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.body.profile.name, 'Meera Rao');
  assert.ok(Array.isArray(dashboard.body.medications));
});

test('family session cannot mutate medications', async () => {
  const login = await request('/api/auth/login', { method:'POST', body: JSON.stringify({ role:'family', passcode:'1357' }) });
  assert.equal(login.response.status, 200);
  familyCookie = login.setCookie.split(';')[0];
  const write = await request('/api/medications', { method:'POST', headers:{cookie:familyCookie}, body:JSON.stringify({name:'Blocked', schedule:'17:00'}) });
  assert.equal(write.response.status, 403);
});
