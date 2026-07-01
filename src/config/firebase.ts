import * as admin from 'firebase-admin';
import { env } from './env';
import { logger } from '../utils/logger';

let firestore: admin.firestore.Firestore | null = null;
let messaging: admin.messaging.Messaging | null = null;
let enabled = false;

// Initialize Firebase Admin from the three-part service-account env vars. If they
// are absent or init fails, we log a warning and leave Firebase disabled so the
// caller can fall back to the in-memory store (graceful degradation, Rule 7).
export function initFirebase(): boolean {
  if (enabled) return true;

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    logger.warn('[Firebase] Not configured — using in-memory store.');
    return false;
  }

  try {
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          // Render stores the key with literal \n — restore real newlines.
          privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    }
    firestore = admin.firestore();
    messaging = admin.messaging();
    enabled = true;
    logger.info('[Firebase] Initialized (Firestore + FCM active).');
    return true;
  } catch (err) {
    logger.warn('[Firebase] Init failed — using in-memory store.', {
      error: (err as Error).message,
    });
    firestore = null;
    messaging = null;
    enabled = false;
    return false;
  }
}

export function isFirebaseEnabled(): boolean {
  return enabled;
}

export function getFirestore(): admin.firestore.Firestore {
  if (!firestore) throw new Error('Firestore requested but Firebase is disabled');
  return firestore;
}

export function getMessaging(): admin.messaging.Messaging | null {
  return messaging;
}
