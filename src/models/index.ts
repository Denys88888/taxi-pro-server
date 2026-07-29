import path from 'path';
import { initFirebase, isFirebaseEnabled } from '../config/firebase';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { setStore } from './store';
import { MemoryStore } from './memory';
import { FirestoreStore } from './firestore';
import { SqliteStore } from './sqlite';

// Choose the persistence backend at startup:
//   1. Firestore  — when Firebase env vars are configured (optional cloud DB)
//   2. SQLite     — primary durable store (WAL), the default
//   3. In-memory  — last-resort fallback if SQLite fails to open
// Which backend ended up active, for the /api/health report.
export type StoreKind = 'firestore' | 'sqlite' | 'memory';
let activeStore: StoreKind = 'memory';
export function storeKind(): StoreKind {
  return activeStore;
}

// Returns whether a durable store (Firestore or SQLite) is active.
export function initStore(): boolean {
  // Optional Firestore, enabled only via env.
  const firebaseOk = initFirebase();
  if (firebaseOk && isFirebaseEnabled()) {
    setStore(new FirestoreStore());
    activeStore = 'firestore';
    logger.info('[Store] Using Firestore (durable, cloud).');
    return true;
  }

  // Primary: SQLite with WAL.
  try {
    const dbPath =
      env.SQLITE_PATH ?? path.join(process.cwd(), 'data', 'taxipro.db');
    setStore(new SqliteStore(dbPath));
    activeStore = 'sqlite';
    logger.info('[Store] Using SQLite (durable, WAL).', { path: dbPath });
    // On Render's free plan the container filesystem is ephemeral: without a
    // mounted disk at the SQLITE_PATH directory, every deploy and every
    // restart wipes rides, payments and payout statuses. Configure Firestore
    // (free tier, see FIREBASE_* env vars) or attach a Render disk.
    if (env.isProd) {
      logger.error(
        '[Store] SQLite in production — data is LOST on every deploy/restart unless a persistent disk is mounted at this path. Configure FIREBASE_* for Firestore, or attach a Render disk.',
        { path: dbPath }
      );
    }
    return true;
  } catch (err) {
    logger.error('[Store] SQLite init failed, falling back to in-memory.', {
      error: (err as Error).message,
    });
  }

  setStore(new MemoryStore());
  activeStore = 'memory';
  if (env.isProd) {
    // Silently serving a payment app out of RAM loses every ride and payout
    // record on restart. Fail fast instead of degrading invisibly.
    logger.error('[Store] No durable store available in production — refusing to start.');
    throw new Error('Refusing to start: no durable store (Firestore or SQLite) available in production');
  }
  logger.warn('[Store] Using in-memory store (non-durable fallback).');
  return false;
}

export { store } from './store';
