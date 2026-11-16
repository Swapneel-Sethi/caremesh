import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../server.mjs';
import { getUsers, getUserById } from '../src/data.mjs';
import { createSession, readSession } from '../src/security.mjs';
import { hashPasscode } from '../src/security.mjs';

const TEST_SECRET = 'test-session-secret';

function makeSessionCookie(userId) {
  return `caremesh_session=${createSession(userId, TEST_SECRET)}`;
}

function makeReq(method, path, body = null, cookie = null, headers = {}) {
  const req = {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:8080', referer: 'http://localhost:8080/', cookie: cookie || '', ...headers },
    url: path,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(JSON.stringify(body));
    }
  };
  return req;
}

function makeRes() {
  const chunks = [];
  let status = 200;
  let resHeaders = {};
  const res = {
    writeHead(s, h) { status = s; resHeaders = h; },
    end(payload) { chunks.push(Buffer.from(payload)); },
    get status() { return status; },
    get headers() { return resHeaders; },
    get body() { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); },
    get setCookie() { 
      const cookie = resHeaders['Set-Cookie'] || resHeaders['set-cookie'];
      return Array.isArray(cookie) ? cookie.join('; ') : (cookie || ''); 
    }
  };
  return res;
}

async function runHandler(handler, req, res) {
  await handler(req, res);
}

test('firebase login returns 503 when Admin SDK not configured', async () => {
  const handler = createHandler({ firebaseLogin: async () => ({ status: 503, body: { error: 'Firebase login unavailable' } }) });
  const req = makeReq('POST', '/api/auth/firebase-login', { idToken: 'fake-token' });
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'Firebase login unavailable');
});

test('firebase login rejects missing idToken', async () => {
  const handler = createHandler({ firebaseLogin: async ({ idToken }) => {
    if (!idToken) return { status: 400, body: { error: 'ID token required' } };
    return { status: 200, body: { user: { uid: 'test-uid', email: 'test@example.com', displayName: 'Test', role: 'pending', status: 'pending' } } };
  }});
  const req = makeReq('POST', '/api/auth/firebase-login', {});
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'ID token required');
});

test('demo login still works', async () => {
  const handler = createHandler();
  const req = makeReq('POST', '/api/auth/login', { role: 'elder', passcode: '1234' });
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 200);
  assert.ok(res.setCookie.includes('HttpOnly'));
  assert.ok(res.setCookie.includes('SameSite=Lax'));
});

test('dashboard returns pending for pending user', async () => {
  const handler = createHandler({ resolveUser: async () => ({ id: 'fb-pending', name: 'Test', role: 'pending', status: 'pending', email: 'test@example.com', initials: 'TE' }) });
  const req = makeReq('GET', '/api/dashboard', null, makeSessionCookie('fb-pending'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.pending, true);
  assert.equal(res.body.user.role, 'pending');
});

test('pending user gets 403 for care-data routes', async () => {
  const handler = createHandler({ resolveUser: async () => ({ id: 'fb-pending', name: 'Test', role: 'pending', status: 'pending', email: 'test@example.com', initials: 'TE' }) });
  const req = makeReq('POST', '/api/medications', { name: 'Test', schedule: '08:00' }, makeSessionCookie('fb-pending'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 403);
});

test('unauthenticated request gets 401', async () => {
  const handler = createHandler();
  const req = makeReq('GET', '/api/dashboard');
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 401);
});

test('logout clears session cookie', async () => {
  const handler = createHandler();
  const req = makeReq('POST', '/api/auth/logout', {}, makeSessionCookie('usr-elder'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 200);
  assert.ok(res.setCookie.includes('Max-Age=0'));
});

test('family role still gets 403 for mutations', async () => {
  const handler = createHandler({ resolveUser: async () => ({ id: 'usr-family', name: 'Family', role: 'family', status: 'active', email: 'family@example.com', initials: 'FA' }) });
  const req = makeReq('POST', '/api/medications', { name: 'Test', schedule: '08:00' }, makeSessionCookie('usr-family'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 403);
});

test('caregiver can access reminders', async () => {
  const handler = createHandler({ resolveUser: async () => ({ id: 'usr-caregiver', name: 'Caregiver', role: 'caregiver', status: 'active', email: 'cg@example.com', initials: 'CG' }) });
  const req = makeReq('POST', '/api/reminders/preview', {}, makeSessionCookie('usr-caregiver'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 200);
});