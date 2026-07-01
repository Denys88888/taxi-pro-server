import { initFirebase, isFirebaseEnabled } from '../config/firebase';
import { logger } from '../utils/logger';
import { setStore } from './store';
import { MemoryStore } from './memory';
import { FirestoreStore } from './firestore';

// Choose the persistence backend at startup: Firestore when configured, else the
// in-memory fallback. Returns whether durable (Firestore) storage is active.
export function initStore(): boolean {
  const firebaseOk = initFirebase();
  if (firebaseOk && isFirebaseEnabled()) {
    setStore(new FirestoreStore());
    logger.info('[Store] Using Firestore (durable).');
    return true;
  }
  setStore(new MemoryStore());
  logger.warn('[Store] Using in-memory store (non-durable fallback).');
  return false;
}

export { store } from './store';
