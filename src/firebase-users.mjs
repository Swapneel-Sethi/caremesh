import { getAdminDb, isFirebaseAdminReady } from './firebase-admin.mjs';

export { isFirebaseAdminReady };

const ROLES = ['elder', 'caregiver', 'family'];

function safeRole(value) {
  return ROLES.includes(value) ? value : 'pending';
}

function safeStatus(role) {
  return (role === 'elder' || role === 'caregiver') ? 'active' : 'pending';
}

export async function getOrCreateUser(uid, { email, displayName }) {
  if (!isFirebaseAdminReady()) {
    throw new Error('Firebase Admin SDK not configured');
  }
  const db = getAdminDb();
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const now = new Date().toISOString();
  if (!snap.exists) {
    const role = 'pending';
    const data = {
      uid,
      email: email || null,
      displayName: displayName || null,
      role,
      status: safeStatus(role),
      createdAt: now,
      updatedAt: now,
      lastSignInAt: now
    };
    await ref.set(data);
    return data;
  }
  const existing = snap.data();
  const role = safeRole(existing.role);
  const status = safeStatus(role);
  const updates = {
    email: email ?? existing.email,
    displayName: displayName ?? existing.displayName,
    role,
    status,
    updatedAt: now,
    lastSignInAt: now
  };
  await ref.update(updates);
  return { ...existing, ...updates };
}

export async function getUserByUid(uid) {
  if (!isFirebaseAdminReady()) return null;
  const db = getAdminDb();
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? snap.data() : null;
}