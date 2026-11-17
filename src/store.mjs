import crypto from 'node:crypto';
import { getAdminDb, isFirebaseAdminReady } from './firebase-admin.mjs';
import { getState as memoryState, addEvent as memoryAddEvent, addMedication as memoryAddMedication, updateMedication as memoryUpdateMedication, addAppointment as memoryAddAppointment } from './data.mjs';

const useFirestore = isFirebaseAdminReady();
const DEMO_RECIPIENT_ID = 'demo-recipient';

function getRecipientId(user) {
  if (user?.source === 'local') return DEMO_RECIPIENT_ID;
  return user?.recipientId || null;
}

function recipientCollectionPath(recipientId, collection) {
  return `careRecipients/${recipientId}/${collection}`;
}

function docRef(db, recipientId, collection, id) {
  return db.collection(recipientCollectionPath(recipientId, collection)).doc(id);
}

function reminderDocId(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function ensureDemoRecipient(db, recipientId) {
  if (recipientId !== DEMO_RECIPIENT_ID) return;

  const recipientRef = db.collection('careRecipients').doc(recipientId);
  const recipientSnap = await recipientRef.get();
  if (!recipientSnap.exists) {
    await recipientRef.set({
      displayName: 'Meera Rao',
      preferredName: 'Meera',
      timezone: 'Asia/Kolkata',
      status: 'active',
      ownerUid: 'usr-elder',
      // Voice calling is opt-in. Demo data stays silent until an operator
      // explicitly configures CARE_VOICE_ENABLED + CARE_VOICE_PHONE.
      allowVoiceCalls: false,
      voicePhone: null,
      voiceLanguage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  const state = memoryState();

  const seedMissing = async (collection, id, data) => {
    const snap = await db.collection(recipientCollectionPath(recipientId, collection)).doc(id).get();
    if (!snap.exists) {
      await db.collection(recipientCollectionPath(recipientId, collection)).doc(id).set(data);
    }
  };

  for (const profile of state.profiles) {
    await seedMissing('profiles', profile.id, profile);
  }

  for (const medication of state.medications) {
    await seedMissing('medications', medication.id, medication);
  }

  for (const appointment of state.appointments) {
    await seedMissing('appointments', appointment.id, appointment);
  }

  for (const member of state.careTeam) {
    await seedMissing('careTeam', member.id, member);
  }

  const eventsSnap = await db.collection(recipientCollectionPath(recipientId, 'events')).limit(1).get();
  if (eventsSnap.empty) {
    for (const event of state.events) {
      await db.collection(recipientCollectionPath(recipientId, 'events')).doc(event.id).set(event);
    }
  }
}

export async function getUserRecipientId(uid) {
  if (!isFirebaseAdminReady()) return null;
  const db = getAdminDb();
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data.recipientId || null;
}

export async function setUserRecipientId(uid, recipientId, role, status) {
  if (!isFirebaseAdminReady()) return;
  const db = getAdminDb();
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const now = new Date().toISOString();
  const updates = {
    recipientId,
    role,
    status,
    updatedAt: now
  };
  if (!snap.exists) {
    await ref.set({
      uid,
      recipientId,
      role,
      status,
      createdAt: now,
      updatedAt: now,
      lastSignInAt: now
    });
  } else {
    await ref.update(updates);
  }
}

export async function domainSnapshot(user) {
  if (!useFirestore) return memoryState();

  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) throw new Error('No recipient assigned');
  await ensureDemoRecipient(db, recipientId);

  const [profiles, medications, appointments, events, careTeam, outbox] = await Promise.all([
    db.collection(recipientCollectionPath(recipientId, 'profiles')).get(),
    db.collection(recipientCollectionPath(recipientId, 'medications')).get(),
    db.collection(recipientCollectionPath(recipientId, 'appointments')).get(),
    db.collection(recipientCollectionPath(recipientId, 'events')).orderBy('at', 'desc').limit(50).get(),
    db.collection(recipientCollectionPath(recipientId, 'careTeam')).get(),
    db.collection(recipientCollectionPath(recipientId, 'outbox')).limit(20).get()
  ]);

  return {
    profiles: profiles.docs.map(d => ({ id: d.id, ...d.data() })),
    medications: medications.docs.map(d => ({ id: d.id, ...d.data() })),
    appointments: appointments.docs.map(d => ({ id: d.id, ...d.data() })),
    events: events.docs.map(d => ({ id: d.id, ...d.data() })),
    careTeam: careTeam.docs.map(d => ({ id: d.id, ...d.data() })),
    outbox: outbox.docs.map(d => ({ id: d.id, ...d.data() }))
  };
}

export async function persistEvent(user, event) {
  if (!useFirestore) return memoryAddEvent(event);
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) throw new Error('No recipient assigned');
  const record = { id: crypto.randomUUID(), ...event, recipientId, createdAt: new Date().toISOString() };
  await docRef(db, recipientId, 'events', record.id).set(record);
  return record;
}

export async function persistMedication(user, input) {
  if (!useFirestore) return memoryAddMedication(input);
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) throw new Error('No recipient assigned');
  const medication = {
    id: crypto.randomUUID(),
    ...input,
    status: 'pending',
    ownerId: 'profile-elder',
    nextDue: `Today · ${input.schedule}`,
    recipientId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await docRef(db, recipientId, 'medications', medication.id).set(medication);
  return medication;
}

export async function persistMedicationUpdate(user, id, patch) {
  if (!useFirestore) return memoryUpdateMedication(id, patch);
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) throw new Error('No recipient assigned');
  const ref = docRef(db, recipientId, 'medications', id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const existing = snap.data();
  const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await ref.set(updated);
  return updated;
}

export async function persistAppointment(user, input) {
  if (!useFirestore) return memoryAddAppointment(input);
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) throw new Error('No recipient assigned');
  const appointment = {
    id: crypto.randomUUID(),
    ...input,
    status: 'upcoming',
    recipientId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await docRef(db, recipientId, 'appointments', appointment.id).set(appointment);
  return appointment;
}

export async function persistOutbox(userOrMessage, maybeMessage) {
  let user, message;
  if (maybeMessage === undefined) {
    message = userOrMessage;
    user = { id: 'system', name: 'CarePulse system', role: 'caregiver', status: 'active', source: 'cron', recipientId: DEMO_RECIPIENT_ID };
  } else {
    user = userOrMessage;
    message = maybeMessage;
  }
  if (!useFirestore) {
    const state = memoryState();
    state.outbox.unshift(message);
    state.outbox = state.outbox.slice(0, 50);
    return message;
  }
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) throw new Error('No recipient assigned');
  await docRef(db, recipientId, 'outbox', message.id).set({ ...message, recipientId });
  return message;
}

export async function reminderKeys(user) {
  if (!useFirestore) return new Set((memoryState().reminders || []).map((record) => record.key));
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) return new Set();
  const collectionPath = recipientCollectionPath(recipientId, 'reminders');
  return new Set();
}

export async function checkReminderExists(user, key) {
  if (!useFirestore) {
    return (memoryState().reminders || []).some((record) => record.key === key);
  }
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) return false;
  const docId = reminderDocId(key);
  const snap = await db.collection(recipientCollectionPath(recipientId, 'reminders')).doc(docId).get();
  return snap.exists;
}

export async function persistReminder(user, record) {
  if (!useFirestore) {
    const state = memoryState();
    state.reminders.unshift(record);
    state.reminders = state.reminders.slice(0, 200);
    return record;
  }
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) throw new Error('No recipient assigned');
  const docId = reminderDocId(record.key);
  await docRef(db, recipientId, 'reminders', docId).set({ ...record, recipientId });
  return record;
}

export async function getCareTeamMembers(user) {
  if (!useFirestore) return memoryState().careTeam;
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) return [];
  const snap = await db.collection(recipientCollectionPath(recipientId, 'careTeam')).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addCareTeamMember(user, memberId, memberData) {
  if (!useFirestore) throw new Error('Care team requires Firestore');
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) throw new Error('No recipient assigned');
  await docRef(db, recipientId, 'careTeam', memberId).set({ ...memberData, recipientId, addedAt: new Date().toISOString() });
  return { id: memberId, ...memberData };
}

export async function removeCareTeamMember(user, memberId) {
  if (!useFirestore) throw new Error('Care team requires Firestore');
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) throw new Error('No recipient assigned');
  await docRef(db, recipientId, 'careTeam', memberId).delete();
}

export async function createInvitation(inviter, recipientId, invitedUid, role, expiresAt) {
  if (!useFirestore) throw new Error('Invitations require Firestore');
  if (!['elder', 'caregiver', 'family'].includes(role)) throw new Error('Invalid role');
  const db = getAdminDb();
  const invitationId = crypto.randomUUID();
  const invitation = {
    id: invitationId,
    recipientId,
    invitedUid,
    role,
    status: 'pending',
    invitedBy: inviter.id,
    invitedByName: inviter.name,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };
  await docRef(db, recipientId, 'invitations', invitationId).set(invitation);
  return invitation;
}

export async function getInvitation(recipientId, invitationId) {
  if (!useFirestore) return null;
  const db = getAdminDb();
  const snap = await docRef(db, recipientId, 'invitations', invitationId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

export async function getInvitationsByRecipient(recipientId) {
  if (!useFirestore) return [];
  const db = getAdminDb();
  const snap = await db.collection(recipientCollectionPath(recipientId, 'invitations')).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function acceptInvitation(user, recipientId, invitationId) {
  if (!useFirestore) throw new Error('Invitations require Firestore');
  const db = getAdminDb();
  const invitation = await getInvitation(recipientId, invitationId);
  if (!invitation) throw new Error('Invitation not found');
  if (invitation.status !== 'pending') throw new Error('Invitation is not pending');
  if (invitation.invitedUid !== user.id) throw new Error('Invitation is not for this user');
  if (new Date(invitation.expiresAt) < new Date()) {
    await docRef(db, recipientId, 'invitations', invitationId).update({ status: 'expired' });
    throw new Error('Invitation has expired');
  }

  // Idempotent: check if active membership already exists
  const existingMember = await docRef(db, recipientId, 'careTeam', user.id).get();
  if (existingMember.exists) {
    const existing = existingMember.data();
    if (existing.status === 'active') {
      return { id: user.id, role: existing.role, status: existing.status, recipientId: existing.recipientId };
    }
  }

  await docRef(db, recipientId, 'invitations', invitationId).update({ status: 'accepted', acceptedAt: new Date().toISOString() });
  await docRef(db, recipientId, 'careTeam', user.id).set({
    uid: user.id,
    role: invitation.role,
    status: 'active',
    permissions: invitation.role === 'elder' ? 'full' : invitation.role === 'caregiver' ? 'medications + appointments + alerts' : 'view + alerts',
    addedBy: invitation.invitedBy,
    addedAt: new Date().toISOString(),
    recipientId: invitation.recipientId
  });

  // Promote the user's canonical record
  await setUserRecipientId(user.id, invitation.recipientId, invitation.role, 'active');

  return { id: user.id, role: invitation.role, status: 'active', recipientId: invitation.recipientId };
}

export async function revokeInvitation(recipientId, invitationId) {
  if (!useFirestore) throw new Error('Invitations require Firestore');
  const db = getAdminDb();
  await docRef(db, recipientId, 'invitations', invitationId).update({ status: 'revoked' });
}

export async function checkRecipientAccess(user, recipientId) {
  if (!useFirestore) return true;
  if (user?.source === 'local') return true;
  const db = getAdminDb();
  const snap = await docRef(db, recipientId, 'careTeam', user.id).get();
  if (!snap.exists) return false;
  const member = snap.data();
  return member.status === 'active';
}

export function canViewRecipient(user) {
  // View access: any non-pending user with a recipient assigned
  return user && !isPending(user) && Boolean(user.recipientId);
}

export function canMutateRecipient(user) {
  // Mutation access: elder or caregiver, not pending, with recipient assigned
  return user && user.role && ['elder', 'caregiver'].includes(user.role) && user.status === 'active' && Boolean(user.recipientId);
}

export function isPending(user) {
  return user?.role === 'pending' || user?.status === 'pending';
}

// --- AI voice escalation persistence -------------------------------------
// Sessions are stored at voiceSessions/{sessionId} (top level) so an inbound
// Twilio webhook can resolve an opaque session id without being told which
// recipient it belongs to. The recipient id never leaves the backend. Call
// records stay scoped to careRecipients/{recipientId}/voiceCalls.

const voiceSessionsMemory = new Map();
const voiceCallsMemory = [];

export async function getCareRecipient(recipientId) {
  if (!recipientId) return null;
  if (!useFirestore) return null;
  const snap = await getAdminDb().collection('careRecipients').doc(recipientId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

function voiceSessionExpired(session) {
  if (!session || !session.expiresAt) return true;
  return new Date(session.expiresAt).getTime() <= Date.now();
}

export async function createVoiceSession(session) {
  if (!session?.id || !session?.recipientId) throw new Error('Voice session requires id and recipient');
  const record = { ...session, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (!useFirestore) {
    voiceSessionsMemory.set(record.id, record);
    return record;
  }
  await getAdminDb().collection('voiceSessions').doc(record.id).set(record);
  return record;
}

export async function getVoiceSession(sessionId) {
  if (!sessionId) return null;
  if (!useFirestore) return voiceSessionsMemory.get(sessionId) || null;
  const snap = await getAdminDb().collection('voiceSessions').doc(sessionId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

// Atomically move a session out of a respondable state. Returns the session
// that this caller now owns, or null when it is expired, completed or already
// being processed. This is what stops a replayed webhook or a double-clicked
// simulator button from mutating medication state twice.
export async function claimVoiceSession(sessionId) {
  if (!sessionId) return null;
  if (!useFirestore) {
    const session = voiceSessionsMemory.get(sessionId);
    if (!session) return null;
    if (voiceSessionExpired(session)) {
      voiceSessionsMemory.set(sessionId, { ...session, status: 'expired', updatedAt: new Date().toISOString() });
      return null;
    }
    if (['completed', 'processing'].includes(session.status)) return null;
    const claimed = { ...session, status: 'processing', updatedAt: new Date().toISOString() };
    voiceSessionsMemory.set(sessionId, claimed);
    return claimed;
  }
  const db = getAdminDb();
  const ref = db.collection('voiceSessions').doc(sessionId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const session = { id: snap.id, ...snap.data() };
    if (voiceSessionExpired(session)) {
      tx.update(ref, { status: 'expired', updatedAt: new Date().toISOString() });
      return null;
    }
    if (['completed', 'processing'].includes(session.status)) return null;
    tx.update(ref, { status: 'processing', updatedAt: new Date().toISOString() });
    return { ...session, status: 'processing' };
  });
}

export async function updateVoiceSession(sessionId, patch) {
  if (!sessionId) return null;
  const updates = { ...patch, updatedAt: new Date().toISOString() };
  if (!useFirestore) {
    const session = voiceSessionsMemory.get(sessionId);
    if (!session) return null;
    const updated = { ...session, ...updates };
    voiceSessionsMemory.set(sessionId, updated);
    return updated;
  }
  const ref = getAdminDb().collection('voiceSessions').doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.set({ ...snap.data(), ...updates });
  return { id: sessionId, ...snap.data(), ...updates };
}

export async function createVoiceCallRecord(recipientId, record) {
  if (!recipientId) throw new Error('No recipient assigned');
  const call = {
    id: crypto.randomUUID(),
    recipientId,
    provider: 'twilio',
    startedAt: new Date().toISOString(),
    ...record
  };
  if (!useFirestore) {
    voiceCallsMemory.unshift(call);
    voiceCallsMemory.splice(200);
    return call;
  }
  await docRef(getAdminDb(), recipientId, 'voiceCalls', call.id).set(call);
  return call;
}

export function voiceCallHistory() {
  return voiceCallsMemory.map((call) => ({ ...call }));
}

export function resetVoiceState() {
  voiceSessionsMemory.clear();
  voiceCallsMemory.length = 0;
}

export function isVoiceSessionExpired(session) {
  return voiceSessionExpired(session);
}

// Atomically reserve a reminder/voice key so concurrent cron invocations cannot
// both start a check-in for the same missed dose. Reuses the existing reminder
// dedupe keys instead of adding a second detection system.
export async function claimReminder(user, record) {
  if (!record?.key) return false;
  if (!useFirestore) {
    const state = memoryState();
    state.reminders = state.reminders || [];
    if (state.reminders.some((item) => item.key === record.key)) return false;
    state.reminders.unshift({ ...record, claimedAt: new Date().toISOString() });
    state.reminders = state.reminders.slice(0, 200);
    return true;
  }
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) return false;
  const ref = db.collection(recipientCollectionPath(recipientId, 'reminders')).doc(reminderDocId(record.key));
  try {
    await ref.create({ ...record, recipientId, claimedAt: new Date().toISOString() });
    return true;
  } catch (error) {
    if (error?.code === 6 || error?.code === 'already-exists') return false;
    throw error;
  }
}

export async function releaseReminder(user, key) {
  if (!key) return;
  if (!useFirestore) {
    const state = memoryState();
    state.reminders = (state.reminders || []).filter((item) => item.key !== key);
    return;
  }
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  if (!recipientId) return;
  await db.collection(recipientCollectionPath(recipientId, 'reminders')).doc(reminderDocId(key)).delete();
}

export function persistenceMode() { return useFirestore ? 'firestore' : 'demo-memory'; }