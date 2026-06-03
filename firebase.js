// Firebase Admin SDK wrapper for Firestore persistence
// Gracefully falls back to disabled state when Firebase is not configured

let admin = null;
let db = null;
let firebaseEnabled = false;

/**
 * Initialize Firebase Admin SDK from environment variables or service account file.
 * Call once at server startup. Safe to call even when Firebase is not configured.
 */
function initFirebase() {
  if (firebaseEnabled) return;

  try {
    // Check for service account JSON in env
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const databaseUrl = process.env.FIREBASE_DATABASE_URL;

    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      admin = require('firebase-admin');
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: databaseUrl || undefined
      });
      db = admin.firestore();
      firebaseEnabled = true;
      console.log('[Firebase] Initialized with service account credentials.');
      return;
    }

    // Check for GOOGLE_APPLICATION_CREDENTIALS (file path)
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_PROJECT_ID) {
      admin = require('firebase-admin');
      const appConfig = {};
      if (projectId) appConfig.projectId = projectId;
      if (databaseUrl) appConfig.databaseURL = databaseUrl;

      if (admin.apps.length === 0) {
        admin.initializeApp(appConfig);
      }
      db = admin.firestore();
      firebaseEnabled = true;
      console.log('[Firebase] Initialized with application default credentials.');
      return;
    }

    // Try to load from serviceAccount.json file in server directory
    const path = require('path');
    const fs = require('fs');
    const serviceAccountPath = path.join(__dirname, 'serviceAccount.json');
    if (fs.existsSync(serviceAccountPath)) {
      const serviceAccount = require(serviceAccountPath);
      admin = require('firebase-admin');
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      db = admin.firestore();
      firebaseEnabled = true;
      console.log('[Firebase] Initialized from serviceAccount.json file.');
      return;
    }

    console.log('[Firebase] No configuration found. Running in in-memory mode.');
  } catch (err) {
    console.warn('[Firebase] Initialization failed, running in in-memory mode:', err.message);
    firebaseEnabled = false;
    admin = null;
    db = null;
  }
}

/** Return whether Firebase Firestore is active. */
function isFirebaseEnabled() {
  return firebaseEnabled;
}

// ─── Firestore helpers ───

/** Get a document by collection and ID. Returns null if not found. */
async function getDoc(collection, id) {
  if (!firebaseEnabled) return null;
  const snap = await db.collection(collection).doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/** Create or overwrite a document. */
async function setDoc(collection, id, data) {
  if (!firebaseEnabled) return;
  await db.collection(collection).doc(id).set(data, { merge: true });
}

/** Merge-update fields in an existing document. */
async function updateDoc(collection, id, data) {
  if (!firebaseEnabled) return;
  await db.collection(collection).doc(id).update(data);
}

/** Delete a document. */
async function deleteDoc(collection, id) {
  if (!firebaseEnabled) return;
  await db.collection(collection).doc(id).delete();
}

/**
 * Query a collection with conditions.
 * conditions: array of {field, op, value} objects.
 * Returns array of docs.
 */
async function queryCollection(collection, conditions = []) {
  if (!firebaseEnabled) return [];
  let q = db.collection(collection);
  for (const { field, op, value } of conditions) {
    q = q.where(field, op, value);
  }
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Get all documents in a collection ordered by a field. */
async function getAllOrdered(collection, field, direction = 'desc') {
  if (!firebaseEnabled) return [];
  const dir = direction === 'asc' ? 'asc' : 'desc';
  const snap = await db.collection(collection).orderBy(field, dir).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Add a document with auto-generated ID. Returns the generated ID. */
async function addDoc(collection, data) {
  if (!firebaseEnabled) {
    const generatedId = `${collection}_${Date.now()}`;
    return generatedId;
  }
  const ref = await db.collection(collection).add(data);
  return ref.id;
}

/** Get messages for a specific chat, ordered by timestamp ascending. */
async function getChatMessages(chatId) {
  if (!firebaseEnabled) return [];
  const snap = await db.collection('messages')
    .where('chatId', '==', chatId)
    .orderBy('timestamp', 'asc')
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Save an FCM push token for a user. Overwrites any existing token for that user. */
async function savePushToken(userId, token) {
  if (!firebaseEnabled) return;
  await db.collection('pushTokens').doc(userId).set({ token, userId, updatedAt: new Date().toISOString() }, { merge: true });
}

/** Get all stored push tokens. Returns array of {userId, token} objects. */
async function getAllPushTokens() {
  if (!firebaseEnabled) return [];
  const snap = await db.collection('pushTokens').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Send a push notification via Firebase Cloud Messaging.
 * token: string — target device FCM token
 * title, body: notification text
 * data: optional payload object
 */
async function sendPushNotification(token, title, body, data = {}) {
  if (!firebaseEnabled || !token) return;
  try {
    const message = {
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      )
    };
    const response = await admin.messaging().send(message);
    console.log('[FCM] Notification sent:', response);
  } catch (err) {
    console.error('[FCM] Failed to send notification:', err.message);
  }
}

module.exports = {
  initFirebase,
  firebaseEnabled,
  isFirebaseEnabled,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  queryCollection,
  getAllOrdered,
  addDoc,
  getChatMessages,
  savePushToken,
  getAllPushTokens,
  sendPushNotification,
  admin
};
