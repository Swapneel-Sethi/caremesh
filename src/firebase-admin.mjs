import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

let adminApp = null;
let adminAuth = null;
let adminDb = null;

function parsePrivateKey(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/\\n/g, '\n').replace(/^"|"$/g, '');
  if (cleaned.includes('-----BEGIN PRIVATE KEY-----') || cleaned.includes('-----BEGIN RSA PRIVATE KEY-----')) {
    return cleaned;
  }
  return null;
}

function isConfigured() {
  return !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
}

function getAdminApp() {
  if (adminApp) return adminApp;
  if (!isConfigured()) return null;
  if (getApps().length) {
    adminApp = getApps()[0];
  } else {
    const privateKey = parsePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
    if (!privateKey) return null;
    adminApp = initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey
      })
    });
  }
  return adminApp;
}

export function getAdminAuth() {
  if (adminAuth) return adminAuth;
  const app = getAdminApp();
  if (!app) return null;
  adminAuth = getAuth(app);
  return adminAuth;
}

export function getAdminDb() {
  if (adminDb) return adminDb;
  const app = getAdminApp();
  if (!app) return null;
  adminDb = getFirestore(app);
  return adminDb;
}

export function isFirebaseAdminReady() {
  return isConfigured() && !!getAdminApp();
}