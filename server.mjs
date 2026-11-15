import http from 'node:http';
import { URL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './src/config.mjs';
import { getUsers, getUserById } from './src/data.mjs';
import { createSession, readSession, verifyPasscode } from './src/security.mjs';
import { validateMedication, validateAppointment } from './src/validation.mjs';
import { generateCareBrief } from './src/google.mjs';
import { sendReminder } from './src/email.mjs';
import { domainSnapshot, persistEvent, persistMedication, persistMedicationUpdate, persistAppointment, persistenceMode } from './src/store.mjs';

const publicDir = path.resolve('public');
const sessions = new Map();
const limiter = new Map();

function setCookie(value) {
  return `caremesh_session=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${8 * 60 * 60}${config.nodeEnv === 'production' ? '; Secure' : ''}`;
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  const token = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith('caremesh_session='))?.split('=').slice(1).join('=');
  return token || null;
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'", ...headers });
  res.end(payload);
}

function bad(res, message, status = 400) { json(res, status, { error: message }); }

async function body(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 200_000) throw new Error('Payload too large');
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid JSON'); }
}

function authUser(req) {
  const token = readCookie(req);
  const session = readSession(token, config.sessionSecret);
  return session ? getUserById(session.userId) : null;
}

function requireAuth(req, res) {
  const user = authUser(req);
  if (!user) { bad(res, 'Authentication required', 401); return null; }
  return user;
}

function requireRoles(user, res, roles) {
  if (!roles.includes(user.role)) { bad(res, 'This role is read-only for the requested action', 403); return false; }
  return true;
}

function rateLimited(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = limiter.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > record.reset) { record.count = 0; record.reset = now + 60_000; }
  record.count++;
  limiter.set(ip, record);
  return record.count > 60;
}

async function api(req, res, url) {
  if (rateLimited(req)) return bad(res, 'Too many requests', 429);
  const method = req.method || 'GET';
  const route = url.pathname;

  if (method === 'GET' && route === '/api/health') return json(res, 200, { ok: true, service: 'caremesh', uptime: process.uptime(), time: new Date().toISOString(), persistence: persistenceMode(), ai: config.googleProject ? 'vertex-ai' : 'deterministic-fallback', email: config.resendApiKey ? 'resend' : 'preview-outbox' });

  if (method === 'POST' && route === '/api/auth/login') {
    const input = await body(req);
    const user = getUsers().find((item) => item.role === input.role);
    if (!user || typeof input.passcode !== 'string' || !verifyPasscode(input.passcode, user.salt, user.hash)) return bad(res, 'Invalid access code', 401);
    const sessionToken = createSession(user.id, config.sessionSecret);
    sessions.set(user.id, sessionToken);
    await persistEvent({ at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: 'Secure access session created', actor: user.name, type: 'security', detail: `${user.role} portal` });
    return json(res, 200, { user: sanitizeUser(user) }, { 'Set-Cookie': setCookie(sessionToken) });
  }

  if (method === 'POST' && route === '/api/auth/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': 'caremesh_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' });

  const user = requireAuth(req, res);
  if (!user) return;

  if (method === 'GET' && route === '/api/me') return json(res, 200, { user: sanitizeUser(user) });

  if (method === 'GET' && route === '/api/dashboard') {
    const state = await domainSnapshot();
    let careBrief = 'Care Brief unavailable.';
    try { careBrief = await generateCareBrief({ profile: state.profiles[0], medications: state.medications, appointments: state.appointments, careTeam: state.careTeam }); } catch (error) { careBrief = `Care Brief fallback\n\n${error.message}`; }
    return json(res, 200, { user: sanitizeUser(user), profile: state.profiles[0], medications: state.medications, appointments: state.appointments, careTeam: state.careTeam, events: state.events, outbox: state.outbox.slice(0, 10), careBrief });
  }

  if (method === 'POST' && route === '/api/medications') {
    if (!requireRoles(user, res, ['elder', 'caregiver'])) return;
    const input = validateMedication(await body(req));
    const med = await persistMedication(input);
    await persistEvent({ at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: 'Medication schedule created', actor: user.name, type: 'medication', detail: med.name });
    return json(res, 201, { medication: med });
  }

  const medMatch = route.match(/^\/api\/medications\/([^/]+)$/);
  if (method === 'PATCH' && medMatch) {
    if (!requireRoles(user, res, ['elder', 'caregiver'])) return;
    const input = await body(req);
    const allowed = {};
    if (['pending', 'taken', 'missed'].includes(input.status)) allowed.status = input.status;
    if (input.instructions) allowed.instructions = String(input.instructions).slice(0, 220);
    const med = await persistMedicationUpdate(medMatch[1], allowed);
    if (!med) return bad(res, 'Medication not found', 404);
    await persistEvent({ at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: `Medication marked ${med.status}`, actor: user.name, type: 'medication', detail: med.name });
    return json(res, 200, { medication: med });
  }

  if (method === 'POST' && route === '/api/appointments') {
    if (!requireRoles(user, res, ['elder', 'caregiver'])) return;
    const input = validateAppointment(await body(req));
    const appointment = await persistAppointment(input);
    await persistEvent({ at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: 'Appointment added', actor: user.name, type: 'appointment', detail: `${appointment.doctor} · ${appointment.date}` });
    return json(res, 201, { appointment });
  }

  if (method === 'POST' && route === '/api/reminders/run') {
    const state = await domainSnapshot();
    const pending = state.medications.filter((med) => med.status === 'pending').slice(0, 3);
    const results = [];
    for (const medication of pending) {
      const emailResult = await sendReminder({
        to: 'careteam.demo@example.com',
        subject: `CareMesh reminder · ${medication.name}`,
        text: `Reminder: ${medication.name} is scheduled for ${medication.schedule}. Please confirm the dose or follow the care plan.`
      });
      results.push({ medicationId: medication.id, ...emailResult });
    }
    await persistEvent({ at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), title: 'Reminder dispatch checked', actor: 'CarePulse', type: 'reminder', detail: `${results.length} pending medication${results.length === 1 ? '' : 's'}` });
    return json(res, 200, { results });
  }

  if (method === 'POST' && route === '/api/care-brief') {
    try {
      const state = await domainSnapshot();
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
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
    res.end(await readFile(filePath));
  } catch { bad(res, 'Not found', 404); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return bad(res, 'Method not allowed', 405);
    return await staticFile(req, res, url);
  } catch (error) {
    console.error('request_error', error.message);
    return json(res, 500, { error: 'Internal server error' });
  }
});

server.listen(config.port, '0.0.0.0', () => console.log(`CareMesh listening on :${config.port}`));
