import crypto from 'node:crypto';
import { config } from './config.mjs';
import { getState as memoryState, addEvent as memoryAddEvent, addMedication as memoryAddMedication, updateMedication as memoryUpdateMedication, addAppointment as memoryAddAppointment } from './data.mjs';

const useFirestore = Boolean(config.googleProject && process.env.USE_FIRESTORE !== 'false');
let cachedToken = null;
let cachedExpiry = 0;

async function googleToken() {
  if (cachedToken && cachedExpiry > Date.now() + 60_000) return cachedToken;
  const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!response.ok) throw new Error(`Google metadata token request failed: ${response.status}`);
  const body = await response.json();
  cachedToken = body.access_token;
  cachedExpiry = Date.now() + Number(body.expires_in || 300) * 1000;
  return cachedToken;
}

function firestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number' && Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, val]) => [key, firestoreValue(val)])) } };
  return { stringValue: String(value) };
}

function fromFirestoreValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, val]) => [key, fromFirestoreValue(val)]));
  return undefined;
}

async function fsRequest(url, options = {}) {
  const token = await googleToken();
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firestore ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.status === 204 ? null : response.json();
}

function collectionUrl(collection) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.googleProject)}/databases/(default)/documents/${collection}`;
}

async function listCollection(collection) {
  const body = await fsRequest(collectionUrl(collection));
  return (body?.documents || []).map((doc) => ({ id: doc.name.split('/').pop(), ...Object.fromEntries(Object.entries(doc.fields || {}).map(([key, value]) => [key, fromFirestoreValue(value)])) }));
}

async function upsert(collection, id, data) {
  await fsRequest(`${collectionUrl(collection)}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, firestoreValue(value)])) }) });
  return { id, ...data };
}

async function deleteDoc(collection, id) {
  await fsRequest(`${collectionUrl(collection)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function seedIfMissing() {
  const [medications, appointments, events, careTeam, profiles] = await Promise.all(['medications','appointments','events','careTeam','profiles'].map(listCollection));
  const state = memoryState();
  if (!profiles.length) await Promise.all(state.profiles.map((doc) => upsert('profiles', doc.id, doc)));
  if (!medications.length) await Promise.all(state.medications.map((doc) => upsert('medications', doc.id, doc)));
  if (!appointments.length) await Promise.all(state.appointments.map((doc) => upsert('appointments', doc.id, doc)));
  if (!events.length) await Promise.all(state.events.map((doc) => upsert('events', doc.id, doc)));
  if (!careTeam.length) await Promise.all(state.careTeam.map((doc) => upsert('careTeam', doc.id, doc)));
}

let seeded = false;

export async function domainSnapshot() {
  if (!useFirestore) return memoryState();
  if (!seeded) { await seedIfMissing(); seeded = true; }
  const [profiles, medications, appointments, events, careTeam, outbox] = await Promise.all([
    listCollection('profiles'), listCollection('medications'), listCollection('appointments'), listCollection('events'), listCollection('careTeam'), listCollection('outbox')
  ]);
  return { profiles, medications, appointments, events: events.sort((a,b) => String(b.at).localeCompare(String(a.at))).slice(0,50), careTeam, outbox: outbox.slice(0,20) };
}

export async function persistEvent(event) {
  if (!useFirestore) return memoryAddEvent(event);
  const record = { id: crypto.randomUUID(), ...event };
  await upsert('events', record.id, record);
  return record;
}

export async function persistMedication(input) {
  if (!useFirestore) return memoryAddMedication(input);
  const medication = { id: crypto.randomUUID(), ...input, status: 'pending', ownerId: 'profile-elder', nextDue: `Today · ${input.schedule}` };
  await upsert('medications', medication.id, medication);
  return medication;
}

export async function persistMedicationUpdate(id, patch) {
  if (!useFirestore) return memoryUpdateMedication(id, patch);
  const existing = (await listCollection('medications')).find((item) => item.id === id);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  await upsert('medications', id, updated);
  return updated;
}

export async function persistAppointment(input) {
  if (!useFirestore) return memoryAddAppointment(input);
  const appointment = { id: crypto.randomUUID(), ...input, status: 'upcoming' };
  await upsert('appointments', appointment.id, appointment);
  return appointment;
}

export async function persistOutbox(message) {
  if (!useFirestore) {
    const state = memoryState();
    state.outbox.unshift(message);
    state.outbox = state.outbox.slice(0, 50);
    return message;
  }
  await upsert('outbox', message.id, message);
  return message;
}

export async function reminderKeys() {
  if (!useFirestore) return new Set((memoryState().reminders || []).map((record) => record.key));
  const records = await listCollection('reminders');
  return new Set(records.map((record) => record.key));
}

export async function persistReminder(record) {
  if (!useFirestore) {
    const state = memoryState();
    state.reminders.unshift(record);
    state.reminders = state.reminders.slice(0, 200);
    return record;
  }
  const id = crypto.createHash('sha256').update(record.key).digest('hex');
  await upsert('reminders', id, record);
  return record;
}

export function persistenceMode() { return useFirestore ? 'firestore' : 'demo-memory'; }
