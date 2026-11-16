import { getUserByUid, isFirebaseAdminReady } from './firebase-users.mjs';

export async function resolveSessionUser(uid, localUsers) {
  if (!uid) return null;
  const local = localUsers?.find(u => u.id === uid);
  if (local) return { ...local, source: 'local' };
  if (!isFirebaseAdminReady()) return null;
  try {
    const firebase = await getUserByUid(uid);
    if (firebase) return { id: firebase.uid, email: firebase.email, name: firebase.displayName, role: firebase.role, status: firebase.status, initials: firebase.displayName?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '??', source: 'firebase' };
  } catch { /* ignore */ }
  return null;
}

export function isPending(user) {
  return user?.role === 'pending' || user?.status === 'pending';
}

export function canAccessRecipient(user) {
  return user && user.role && ['elder', 'caregiver'].includes(user.role) && user.status === 'active';
}