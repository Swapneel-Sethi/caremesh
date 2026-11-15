import crypto from 'node:crypto';

export function hashPasscode(passcode, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(passcode), salt, 32).toString('hex');
  return { salt, hash };
}

export function verifyPasscode(passcode, salt, expectedHash) {
  const actual = crypto.scryptSync(String(passcode), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'));
}

function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function createSession(userId, secret, ttlSeconds = 8 * 60 * 60) {
  const payload = `${userId}.${Date.now() + ttlSeconds * 1000}`;
  return `${payload}.${hmac(payload, secret)}`;
}

export function readSession(token, secret) {
  if (!token) return null;
  const [userId, expiresAt, signature] = token.split('.');
  if (!userId || !expiresAt || !signature) return null;
  if (Number(expiresAt) < Date.now()) return null;
  const payload = `${userId}.${expiresAt}`;
  const expected = hmac(payload, secret);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return { userId };
}
