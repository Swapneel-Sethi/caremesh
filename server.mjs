import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './src/config.mjs';
import { getUsers, getUserById } from './src/data.mjs';
import { createSession, readSession, verifyPasscode } from './src/security.mjs';
import { validateMedication, validateAppointment } from './src/validation.mjs';
import { generateCareBrief } from './src/google.mjs';
import { previewReminders, runReminders } from './src/reminders.mjs';
import { domainSnapshot, persistEvent, persistMedication, persistMedicationUpdate, persistAppointment, persistenceMode, createInvitation, getInvitation, getInvitationsByRecipient, acceptInvitation, revokeInvitation, checkRecipientAccess, addCareTeamMember, removeCareTeamMember, getCareTeamMembers, canViewRecipient, canMutateRecipient, isPending, getUserRecipientId } from './src/store.mjs';
const DEMO_RECIPIENT_ID = 'demo-recipient';
import { firebaseLogin } from './src/firebase-login.mjs';
import { resolveSessionUser } from './src/identity.mjs';

const publicDir = path.resolve('public');
const limiter = new Map();

function cookieFlags() {
  return `HttpOnly; Path=/; SameSite=Lax${config.nodeEnv === 'production' ? '; Secure' : ''}`;
}

function setCookie(value) {
  return `caremesh_session=${value}; ${cookieFlags()}; Max-Age=${8 * 60 * 60}`;
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  const token = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith('caremesh_session='))?.split('=').slice(1).join('=');
  return token || null;
}

const CSP_BASE = "default-src 'self'; script-src 'self' https://www.gstatic.com https://apis.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://www.googleapis.com; frame-src 'self' https://caremesh-flare-2026.firebaseapp.com https://accounts.google.com; frame-ancestors 'none'";
const CSP_API = CSP_BASE + "; script-src 'self' https://www.gstatic.com https://apis.google.com; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://www.googleapis.com";

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP_API, ...headers });
  res.end(payload);
}

function bad(res, message, status = 400) { json(res, status, { error: message }); }

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 200_000) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid JSON'); }
}

async function readObject(req) {
  const input = await body(req);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Request body must be a JSON object');
  return input;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const record = limiter.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > record.reset) { record.count = 0; record.reset = now + 60_000; }
  record.count++;
  limiter.set(ip, record);
  return record.count > 60;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function safeOutbox(outbox) {
  return (outbox || []).slice(0, 10).map(({ id, kind, subject, status, sentAt, providerStatus }) => ({ id, kind, subject, status, sentAt, providerStatus }));
}

function validateOrigin(req, allowed = [config.appOrigin, 'http://localhost:8080', 'http://127.0.0.1:8080']) {
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    return allowed.some(o => {
      try {
        const allowedUrl = new URL(o);
        return originUrl.hostname === allowedUrl.hostname && originUrl.protocol === allowedUrl.protocol && originUrl.port === allowedUrl.port;
      } catch { return false; }
    });
  } catch { return false; }
}

async function api(req, res, url, deps = {}) {
  const { firebaseLogin: doFirebaseLogin = firebaseLogin, resolveUser = resolveSessionUser } = deps;
  const method = req.method || 'GET';
  const route = url.pathname;

  if (method === 'GET' && route === '/api/health') {
    return json(res, 200, {
      ok: true,
      service: 'caremesh',
      uptime: process.uptime(),
      time: new Date().toISOString(),
      persistence: persistenceMode(),
      ai: config.googleProject ? 'vertex-ai' : 'deterministic-fallback',
      email: config.resendApiKey ? 'resend' : 'preview-outbox',
      cron: config.cronSecret ? 'configured' : 'unconfigured',
      reminders: config.careTeamAlertEmails.length ? 'configured' : 'unconfigured'
    });
  }

  if ((method === 'GET' || method === 'POST') && route === '/api/cron/reminders') {
    if (!config.cronSecret) return bad(res, 'Scheduled reminders are not configured', 503);
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!safeEqual(token, config.cronSecret)) return bad(res, 'Unauthorized', 401);
    const cronUser = { id: 'cron', name: 'CarePulse schedule', role: 'caregiver', status: 'active', source: 'cron' };
    const result = await runReminders({ actor: 'CarePulse schedule', user: cronUser });
    return json(res, 200, { ok: true, ...result });
  }

  if (rateLimited(req)) return bad(res, 'Too many requests', 429);

  if ((method === 'GET' || method === 'POST') && route === '/api/auth/login') {
    if (method === 'GET') return bad(res, 'Method not allowed', 405);
    if (!validateOrigin(req)) return bad(res, 'Invalid origin', 403);
    let input;
    try { input = await readObject(req); } catch (error) { return bad(res, error.message, 400); }
    if (typeof input.role !== 'string' || typeof input.passcode !== 'string') return bad(res, 'Role and access code are required', 400);
    const user = getUsers().find((item) => item.role === input.role);
    if (!user || !verifyPasscode(input.passcode, user.salt, user.hash)) return bad(res, 'Invalid access code', 401);
    const sessionToken = createSession(user.id, config.sessionSecret);
    await persistEvent(user, { at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: 'Secure access session created', actor: user.name, type: 'security', detail: `${user.role} portal` });
    return json(res, 200, { user: sanitizeUser(user) }, { 'Set-Cookie': setCookie(sessionToken) });
  }

  if ((method === 'GET' || method === 'POST') && route === '/api/auth/firebase-login') {
    if (method === 'GET') return bad(res, 'Method not allowed', 405);
    if (!validateOrigin(req)) return bad(res, 'Invalid origin', 403);
    let input;
    try { input = await readObject(req); } catch (error) { return bad(res, error.message, 400); }
    const result = await doFirebaseLogin({ idToken: input?.idToken });
    if (result.status !== 200) return json(res, result.status, result.body);
    const fbUser = result.body.user;
    if (!fbUser || !fbUser.uid) return json(res, 500, { error: 'User provisioning failed' });
    const sessionToken = createSession(fbUser.uid, config.sessionSecret);
    await persistEvent({ id: fbUser.uid, name: fbUser.displayName || fbUser.email, role: fbUser.role || 'pending', status: fbUser.status || 'pending', source: 'firebase' }, { at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: 'Firebase session created', actor: fbUser.displayName || fbUser.email, type: 'security', detail: `Firebase Google login` });
    return json(res, 200, { user: fbUser }, { 'Set-Cookie': setCookie(sessionToken) });
  }

  if ((method === 'GET' || method === 'POST') && route === '/api/auth/logout') {
    if (method === 'GET') return bad(res, 'Method not allowed', 405);
    return json(res, 200, { ok: true }, { 'Set-Cookie': `caremesh_session=; ${cookieFlags()}; Max-Age=0` });
  }

  async function getUser() {
    const token = readCookie(req);
    const session = readSession(token, config.sessionSecret);
    return session ? await resolveUser(session.userId, getUsers()) : null;
  }

  if (method === 'GET' && route === '/api/me') {
    const user = await getUser();
    if (!user) return bad(res, 'Authentication required', 401);
    return json(res, 200, { user: sanitizeUser(user) });
  }

  if (method === 'GET' && route === '/api/dashboard') {
    const user = await getUser();
    if (!user) return bad(res, 'Authentication required', 401);
    if (isPending(user)) {
      return json(res, 200, { pending: true, user: sanitizeUser(user) });
    }
    if (!canViewRecipient(user)) return bad(res, 'No recipient assigned', 403);
    let state;
    try {
      state = await domainSnapshot(user);
    } catch (error) {
      console.error('dashboard domainSnapshot error:', error);
      return json(res, 500, { error: 'Dashboard snapshot failed', detail: error.message });
    }
    let careBrief = 'Care Brief unavailable.';
    try { careBrief = await generateCareBrief({ profile: state.profiles[0], medications: state.medications, appointments: state.appointments, careTeam: state.careTeam }); } catch (error) { careBrief = `Care Brief fallback\n\n${error.message}`; }
    return json(res, 200, { user: sanitizeUser(user), profile: state.profiles[0], medications: state.medications, appointments: state.appointments, careTeam: state.careTeam, events: state.events, outbox: safeOutbox(state.outbox), careBrief });
  }

  const invMatch = route.match(/^\/api\/invitations\/([^/]+)\/accept$/);
  if (method === 'POST' && invMatch) {
    const authUser = await getUser();
    if (!authUser) return bad(res, 'Authentication required', 401);
    let recipientId;
    if (authUser.source === 'local') {
      recipientId = DEMO_RECIPIENT_ID;
    } else {
      recipientId = await getUserRecipientId(authUser.id);
      if (!recipientId) return bad(res, 'No recipient assigned', 403);
    }
    try {
      const membership = await acceptInvitation(authUser, recipientId, invMatch[1]);
      await persistEvent(authUser, { at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: 'Invitation accepted', actor: authUser.name, type: 'security', detail: `Joined care circle as ${membership.role}` });
      return json(res, 200, { membership });
    } catch (error) { return bad(res, error.message, 400); }
  }

  const user = await getUser();
  if (!user) return bad(res, 'Authentication required', 401);
  let recipientId;
  if (user.source === 'local') {
    recipientId = DEMO_RECIPIENT_ID;
  } else {
    recipientId = await getUserRecipientId(user.id);
    if (!recipientId) return bad(res, 'No recipient assigned', 403);
  }

  if (!canViewRecipient(user)) return bad(res, 'No recipient access', 403);
  if (!(await checkRecipientAccess(user, recipientId))) return bad(res, 'No access to this care recipient', 403);

  if (method === 'POST' && route === '/api/medications') {
    if (!canMutateRecipient(user)) return bad(res, 'This role is read-only for the requested action', 403);
    let input;
    try { input = validateMedication(await readObject(req)); } catch (error) { return bad(res, error.message, 400); }
    const med = await persistMedication(user, input);
    await persistEvent(user, { at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: 'Medication schedule created', actor: user.name, type: 'medication', detail: med.name });
    return json(res, 201, { medication: med });
  }

  const medMatch = route.match(/^\/api\/medications\/([^/]+)$/);
  if (method === 'PATCH' && medMatch) {
    if (!canMutateRecipient(user)) return bad(res, 'This role is read-only for the requested action', 403);
    let input;
    try { input = await readObject(req); } catch (error) { return bad(res, error.message, 400); }
    const allowed = {};
    if (['pending', 'taken', 'missed'].includes(input.status)) allowed.status = input.status;
    if (typeof input.instructions === 'string' && input.instructions.trim()) allowed.instructions = input.instructions.trim().slice(0, 220);
    if (!Object.keys(allowed).length) return bad(res, 'No valid medication update provided', 400);
    const med = await persistMedicationUpdate(user, medMatch[1], allowed);
    if (!med) return bad(res, 'Medication not found', 404);
    await persistEvent(user, { at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: `Medication marked ${med.status}`, actor: user.name, type: 'medication', detail: med.name });
    return json(res, 200, { medication: med });
  }

  if (method === 'POST' && route === '/api/appointments') {
    if (!canMutateRecipient(user)) return bad(res, 'This role is read-only for the requested action', 403);
    let input;
    try { input = validateAppointment(await readObject(req)); } catch (error) { return bad(res, error.message, 400); }
    const appointment = await persistAppointment(user, input);
    await persistEvent(user, { at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: 'Appointment added', actor: user.name, type: 'appointment', detail: `${appointment.doctor} · ${appointment.date}` });
    return json(res, 201, { appointment });
  }

  if (method === 'POST' && route === '/api/reminders/preview') {
    if (!canViewRecipient(user)) return bad(res, 'No recipient access', 403);
    const candidates = await previewReminders({ user });
    return json(res, 200, { candidates, checkedAt: new Date().toISOString(), timeZone: config.reminderTimeZone });
  }

  if (method === 'POST' && route === '/api/reminders/run') {
    if (!canMutateRecipient(user)) return bad(res, 'This role is read-only for the requested action', 403);
    const result = await runReminders({ actor: user.name, user });
    return json(res, 200, result);
  }

  if (method === 'POST' && route === '/api/invitations') {
    if (!canMutateRecipient(user)) return bad(res, 'This role is read-only for the requested action', 403);
    let input;
    try { input = await readObject(req); } catch (error) { return bad(res, error.message, 400); }
    const { invitedUid, role, expiresAt } = input;
    if (!invitedUid || typeof invitedUid !== 'string') return bad(res, 'Invited user ID is required', 400);
    if (!role || !['elder', 'caregiver', 'family'].includes(role)) return bad(res, 'Valid role is required', 400);
    try {
      const invitation = await createInvitation(user, recipientId, invitedUid, role, expiresAt);
      await persistEvent(user, { at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: 'Care invitation created', actor: user.name, type: 'security', detail: `Invite ${invitedUid} as ${role}` });
      return json(res, 201, { invitation });
    } catch (error) { return bad(res, error.message, 400); }
  }

  const invRevokeMatch = route.match(/^\/api\/invitations\/([^/]+)\/revoke$/);
  if (method === 'POST' && invRevokeMatch) {
    if (!canMutateRecipient(user)) return bad(res, 'This role is read-only for the requested action', 403);
    try {
      await revokeInvitation(recipientId, invRevokeMatch[1]);
      return json(res, 200, { ok: true });
    } catch (error) { return bad(res, error.message, 400); }
  }

  if (method === 'GET' && route === '/api/invitations') {
    if (!canViewRecipient(user)) return bad(res, 'No recipient access', 403);
    try {
      const invitations = await getInvitationsByRecipient(recipientId);
      return json(res, 200, { invitations });
    } catch (error) { return bad(res, error.message, 400); }
  }

  if (method === 'POST' && route === '/api/care-brief') {
    if (!canViewRecipient(user)) return bad(res, 'No recipient access', 403);
    try {
      const state = await domainSnapshot(user);
      const careBrief = await generateCareBrief({ profile: state.profiles[0], medications: state.medications, appointments: state.appointments, careTeam: state.careTeam });
      return json(res, 200, { careBrief });
    } catch { return bad(res, 'Care Brief generation failed', 503); }
  }

  return bad(res, 'Not found', 404);
}

function sanitizeUser(user) {
  return { id: user.id, name: user.name, role: user.role, initials: user.initials, email: user.email };
}

async function staticFile(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) return bad(res, 'Forbidden', 403);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return bad(res, 'Not found', 404);
    const ext = path.extname(filePath);
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP_BASE });
    res.end(await readFile(filePath));
  } catch { bad(res, 'Not found', 404); }
}

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url, deps);
      if (req.method !== 'GET' && req.method !== 'HEAD') return bad(res, 'Method not allowed', 405);
      return await staticFile(req, res, url);
    } catch (error) {
      console.error('request_error', error.message);
      return json(res, 500, { error: 'Internal server error' });
    }
  };
}

export default createHandler();

if (!process.env.VERCEL) {
  const server = http.createServer(createHandler());
  server.listen(config.port, '0.0.0.0', () => console.log(`CareMesh listening on :${config.port}`));
}