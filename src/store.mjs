import crypto from 'node:crypto';
import { getAdminDb, isFirebaseAdminReady } from './firebase-admin.mjs';
import { getState as memoryState, addEvent as memoryAddEvent, addMedication as memoryAddMedication, updateMedication as memoryUpdateMedication, addAppointment as memoryAddAppointment } from './data.mjs';

const useFirestore = isFirebaseAdminReady();
const DEMO_RECIPIENT_ID = 'demo-recipient';

function getRecipientId(user) {
  if (user?.source === 'local') return DEMO_RECIPIENT_ID;
  return DEMO_RECIPIENT_ID;
}

function recipientCollectionPath(recipientId, collection) {
  return `careRecipients/${recipientId}/${collection}`;
}

function docRef(db, recipientId, collection, id) {
  return db.collection(recipientCollectionPath(recipientId, collection)).doc(id);
}

async function ensureDemoRecipient(db, recipientId) {
  const ref = db.collection('careRecipients').doc(recipientId);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      displayName: 'Meera Rao',
      preferredName: 'Meera',
      timezone: 'Asia/Kolkata',
      status: 'active',
      ownerUid: 'usr-elder',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
}

export async function domainSnapshot(user) {
  if (!useFirestore) return memoryState();

  const db = getAdminDb();
  const recipientId = getRecipientId(user);
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
  const record = { id: crypto.randomUUID(), ...event, recipientId, createdAt: new Date().toISOString() };
  await docRef(db, recipientId, 'events', record.id).set(record);
  return record;
}

export async function persistMedication(user, input) {
  if (!useFirestore) return memoryAddMedication(input);
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
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
    user = { id: 'system', name: 'CarePulse system', role: 'caregiver', status: 'active', source: 'cron' };
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
  await docRef(db, recipientId, 'outbox', message.id).set({ ...message, recipientId });
  return message;
}

export async function reminderKeys(user) {
  if (!useFirestore) return new Set((memoryState().reminders || []).map((record) => record.key));
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  const snap = await db.collection(recipientCollectionPath(recipientId, 'reminders')).get();
  return new Set(snap.docs.map(d => d.data().key));
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
  const id = crypto.createHash('sha256').update(record.key).digest('hex');
  await docRef(db, recipientId, 'reminders', id).set({ ...record, recipientId });
  return record;
}

export async function getCareTeamMembers(user) {
  if (!useFirestore) return memoryState().careTeam;
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  const snap = await db.collection(recipientCollectionPath(recipientId, 'careTeam')).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addCareTeamMember(user, memberId, memberData) {
  if (!useFirestore) throw new Error('Care team requires Firestore');
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
  await docRef(db, recipientId, 'careTeam', memberId).set({ ...memberData, recipientId, addedAt: new Date().toISOString() });
  return { id: memberId, ...memberData };
}

export async function removeCareTeamMember(user, memberId) {
  if (!useFirestore) throw new Error('Care team requires Firestore');
  const db = getAdminDb();
  const recipientId = getRecipientId(user);
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
  await docRef(db, recipientId, 'invitations', invitationId).update({ status: 'accepted', acceptedAt: new Date().toISOString() });
  await docRef(db, recipientId, 'careTeam', user.id).set({
    uid: user.id,
    role: invitation.role,
    status: 'active',
    permissions: invitation.role === 'elder' ? 'full' : invitation.role === 'caregiver' ? 'medications + appointments + alerts' : 'view + alerts',
    addedBy: invitation.invitedBy,
    addedAt: new Date().toISOString(),
    recipientId
  });
  return { id: user.id, role: invitation.role, status: 'active' };
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

export function persistenceMode() { return useFirestore ? 'firestore' : 'demo-memory'; }