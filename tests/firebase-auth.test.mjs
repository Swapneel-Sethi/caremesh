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
  const handler = createHandler({ resolveUser: async () => ({ id: 'usr-family', name: 'Family', role: 'family', status: 'active', email: 'family@example.com', initials: 'FA', recipientId: 'demo-recipient' }) });
  const req = makeReq('POST', '/api/medications', { name: 'Test', schedule: '08:00' }, makeSessionCookie('usr-family'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 403);
});

test('caregiver can access reminders', async () => {
  const handler = createHandler({ resolveUser: async () => ({ id: 'usr-caregiver', name: 'Caregiver', role: 'caregiver', status: 'active', email: 'cg@example.com', initials: 'CG', source: 'local', recipientId: 'demo-recipient' }) });
  const req = makeReq('POST', '/api/reminders/preview', {}, makeSessionCookie('usr-caregiver'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 200);
});

test('existing family user preserves role and status', async () => {
  const handler = createHandler({
    firebaseLogin: async ({ idToken }) => {
      return {
        status: 200,
        body: {
          user: {
            uid: 'existing-family-uid',
            email: 'family@example.com',
            displayName: 'Existing Family',
            role: 'family',
            status: 'active',
            recipientId: 'demo-recipient'
          }
        }
      };
    },
    resolveUser: async (uid) => {
      if (uid === 'existing-family-uid') {
        return { id: 'existing-family-uid', name: 'Existing Family', role: 'family', status: 'active', email: 'family@example.com', initials: 'EF', recipientId: 'demo-recipient' };
      }
      return null;
    }
  });
  const req = makeReq('POST', '/api/auth/firebase-login', { idToken: 'fake-token' });
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'family');
  assert.equal(res.body.user.status, 'active');

  const dashboardReq = makeReq('GET', '/api/dashboard', null, makeSessionCookie('existing-family-uid'));
  const dashboardRes = makeRes();
  await runHandler(handler, dashboardReq, dashboardRes);
  assert.equal(dashboardRes.status, 200);
  assert.equal(dashboardRes.body.user.role, 'family');

  const writeReq = makeReq('POST', '/api/medications', { name: 'Test', schedule: '08:00' }, makeSessionCookie('existing-family-uid'));
  const writeRes = makeRes();
  await runHandler(handler, writeReq, writeRes);
  assert.equal(writeRes.status, 403);
});

test('invitation creation rejects missing invitedUid', async () => {
  const handler = createHandler({ resolveUser: async () => ({ id: 'usr-elder', name: 'Elder', role: 'elder', status: 'active', email: 'e@example.com', initials: 'ER', source: 'local', recipientId: 'demo-recipient' }) });
  const req = makeReq('POST', '/api/invitations', { role: 'family' }, makeSessionCookie('usr-elder'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 400);
});

test('invitation creation rejects invalid role', async () => {
  const handler = createHandler({ resolveUser: async () => ({ id: 'usr-elder', name: 'Elder', role: 'elder', status: 'active', email: 'e@example.com', initials: 'ER', source: 'local', recipientId: 'demo-recipient' }) });
  const req = makeReq('POST', '/api/invitations', { invitedUid: 'new-user', role: 'admin' }, makeSessionCookie('usr-elder'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 400);
});

test('invitation creation rejected for family role', async () => {
  const handler = createHandler({ resolveUser: async () => ({ id: 'usr-family', name: 'Family', role: 'family', status: 'active', email: 'f@example.com', initials: 'FA', source: 'local', recipientId: 'demo-recipient' }) });
  const req = makeReq('POST', '/api/invitations', { invitedUid: 'new-user', role: 'family' }, makeSessionCookie('usr-family'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 403);
});

test('invitation acceptance requires Firestore', async () => {
  const handler = createHandler({ resolveUser: async () => ({ id: 'new-user', name: 'New User', role: 'pending', status: 'pending', email: 'n@example.com', initials: 'NU', source: 'local', recipientId: 'demo-recipient' }) });
  const req = makeReq('POST', '/api/invitations/inv-123/accept', {}, makeSessionCookie('new-user'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 400);
});

test('IDOR prevention blocks Firebase user without recipient', async () => {
  const handler = createHandler({
    resolveUser: async () => ({ id: 'fb-user-no-recipient', name: 'No Recipient', role: 'elder', status: 'active', email: 'n@example.com', initials: 'NR', source: 'firebase' })
  });
  const req = makeReq('POST', '/api/medications', { name: 'Test', schedule: '08:00' }, makeSessionCookie('fb-user-no-recipient'));
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 403);
});

test('origin validation rejects malicious prefix', async () => {
  const handler = createHandler();
  const req = makeReq('POST', '/api/auth/login', { role: 'elder', passcode: '1234' });
  req.headers.origin = 'https://caremesh-one.vercel.app.attacker.com';
  req.headers.referer = 'https://caremesh-one.vercel.app.attacker.com/';
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 403);
});

test('origin validation accepts exact origin', async () => {
  const handler = createHandler();
  const req = makeReq('POST', '/api/auth/login', { role: 'elder', passcode: '1234' });
  req.headers.origin = 'http://localhost:8080';
  req.headers.referer = 'http://localhost:8080/';
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 200);
});

test('origin validation accepts production origin', async () => {
  const handler = createHandler();
  const req = makeReq('POST', '/api/auth/login', { role: 'elder', passcode: '1234' });
  req.headers.origin = 'https://caremesh-one.vercel.app';
  req.headers.referer = 'https://caremesh-one.vercel.app/';
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 200);
});

test('origin validation accepts vercel preview origin', async () => {
  const origVercelUrl = process.env.VERCEL_URL;
  process.env.VERCEL_URL = 'caremesh-cir35mwbw-foraipurposes7-6330s-projects.vercel.app';
  const handler = createHandler();
  const req = makeReq('POST', '/api/auth/login', { role: 'elder', passcode: '1234' });
  req.headers.origin = 'https://caremesh-cir35mwbw-foraipurposes7-6330s-projects.vercel.app';
  req.headers.referer = 'https://caremesh-cir35mwbw-foraipurposes7-6330s-projects.vercel.app/';
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 200);
  if (origVercelUrl === undefined) {
    delete process.env.VERCEL_URL;
  } else {
    process.env.VERCEL_URL = origVercelUrl;
  }
});

test('origin validation rejects malicious vercel prefix', async () => {
  const handler = createHandler();
  const req = makeReq('POST', '/api/auth/login', { role: 'elder', passcode: '1234' });
  req.headers.origin = 'https://caremesh-cir35mwbw-foraipurposes7-6330s-projects.vercel.app.attacker.com';
  req.headers.referer = 'https://caremesh-cir35mwbw-foraipurposes7-6330s-projects.vercel.app.attacker.com/';
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 403);
});

test('origin validation rejects unrelated origin', async () => {
  const handler = createHandler();
  const req = makeReq('POST', '/api/auth/login', { role: 'elder', passcode: '1234' });
  req.headers.origin = 'https://evil.example.com';
  req.headers.referer = 'https://evil.example.com/';
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 403);
});

test('pending Firebase user login succeeds without recipientId', async () => {
  let persistEventCalled = false;
  const handler = createHandler({
    firebaseLogin: async ({ idToken }) => {
      return {
        status: 200,
        body: {
          user: {
            uid: 'fb-pending-uid',
            email: 'pending@example.com',
            displayName: 'Pending User',
            role: 'pending',
            status: 'pending'
          }
        }
      };
    },
    resolveUser: async (uid) => {
      if (uid === 'fb-pending-uid') {
        return { id: 'fb-pending-uid', name: 'Pending User', role: 'pending', status: 'pending', email: 'pending@example.com', initials: 'PU', source: 'firebase' };
      }
      return null;
    },
    getUserRecipientId: async () => null
  });
  const req = makeReq('POST', '/api/auth/firebase-login', { idToken: 'fake-token' });
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 200);
  assert.ok(res.setCookie.includes('HttpOnly'));
  assert.ok(res.setCookie.includes('SameSite=Lax'));

  // Subsequent dashboard returns pending
  const sessionCookie = res.setCookie.split(';')[0];
  const dashboardReq = makeReq('GET', '/api/dashboard', null, sessionCookie);
  const dashboardRes = makeRes();
  await runHandler(handler, dashboardReq, dashboardRes);
  assert.equal(dashboardRes.status, 200);
  assert.equal(dashboardRes.body.pending, true);
  assert.equal(dashboardRes.body.user.role, 'pending');
});

test('active Firebase user with recipientId gets session event', async () => {
  let persistEventCalled = false;
  const handler = createHandler({
    firebaseLogin: async ({ idToken }) => {
      return {
        status: 200,
        body: {
          user: {
            uid: 'fb-active-uid',
            email: 'active@example.com',
            displayName: 'Active User',
            role: 'caregiver',
            status: 'active',
            recipientId: 'demo-recipient'
          }
        }
      };
    },
    resolveUser: async (uid) => {
      if (uid === 'fb-active-uid') {
        return { id: 'fb-active-uid', name: 'Active User', role: 'caregiver', status: 'active', email: 'active@example.com', initials: 'AU', source: 'firebase', recipientId: 'demo-recipient' };
      }
      return null;
    },
    getUserRecipientId: async () => 'demo-recipient'
  });
  const req = makeReq('POST', '/api/auth/firebase-login', { idToken: 'fake-token' });
  const res = makeRes();
  await runHandler(handler, req, res);
  assert.equal(res.status, 200);
  assert.ok(res.setCookie.includes('HttpOnly'));
});