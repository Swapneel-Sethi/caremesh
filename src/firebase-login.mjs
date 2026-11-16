import { getAdminAuth, isFirebaseAdminReady } from './firebase-admin.mjs';
import { getOrCreateUser } from './firebase-users.mjs';

export async function firebaseLogin({ idToken }) {
  if (!isFirebaseAdminReady()) {
    return { status: 503, body: { error: 'Firebase login unavailable' } };
  }
  if (typeof idToken !== 'string' || !idToken.trim()) {
    return { status: 400, body: { error: 'ID token required' } };
  }
  const auth = getAdminAuth();
  let decoded;
  try {
    decoded = await auth.verifyIdToken(idToken, true);
  } catch (error) {
    if (error.code === 'auth/id-token-revoked' || error.code === 'auth/id-token-expired') {
      return { status: 401, body: { error: 'Session expired, please sign in again' } };
    }
    return { status: 401, body: { error: 'Invalid ID token' } };
  }
  const { uid, email, name: displayName } = decoded;
  if (uid.includes('.')) {
    return { status: 400, body: { error: 'Invalid user identifier' } };
  }
  let user;
  try {
    user = await getOrCreateUser(uid, { email, displayName });
  } catch (error) {
    return { status: 500, body: { error: 'User provisioning failed' } };
  }
  return { status: 200, body: { user: { uid, email: user.email, displayName: user.displayName, role: user.role, status: user.status } } };
}