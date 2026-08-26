/**
 * One-time copy: every Firestore document → the local SQLite store.
 *
 * Run with the real production environment already loaded (Render Shell, not
 * a laptop — this repo's own rule is that FIREBASE_* and PI_WALLET_SEED are
 * never typed or read by hand, and this script only works because the shell
 * it runs in already has them as real env vars):
 *
 *   npx tsx src/scripts/migrateFirestoreToSqlite.ts
 *
 * Firestore is READ-ONLY here — nothing in this file ever calls .delete() or
 * .update() against it. The point is to make SQLite a faithful copy while
 * Firestore keeps serving traffic untouched, so switching the active store
 * (via initStore() preferring Firestore whenever FIREBASE_* is set) stays a
 * one-line, instantly-reversible decision made *after* this script has been
 * run and its counts checked — not a cutover this script performs itself.
 *
 * Idempotent. `users`, `rides`, `payments`, `push_tokens` and `settings` are
 * upserts in SqliteStore already; `messages` and `reports` are plain INSERTs
 * (their id is enough to identify a row, there is nothing to update), so a
 * second run hits SQLITE_CONSTRAINT on rows it already copied — that specific
 * error is swallowed and counted as "already there", anything else is not.
 *
 * Known gap: the `ratings` table is a derived index nothing currently reads
 * (grep confirms no SELECT against it), populated only as a side effect of
 * updateRide() when a rating patch is applied. A migrated ride keeps its
 * driverRating/passengerRating in its own JSON — a driver's rating history
 * shown from that table specifically, if one is ever built, would need a
 * backfill pass added here first.
 */
import { initFirebase, getFirestore } from '../config/firebase';
import { SqliteStore } from '../models/sqlite';
import { env } from '../config/env';
import type { User, Ride, Message, Payment, PushToken, Report, Settings } from '../types';

interface Tally {
  name: string;
  source: number;
  copied: number;
  alreadyPresent: number;
  failed: number;
}

function isPrimaryKeyConflict(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

async function copyCollection<T>(
  name: string,
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
  write: (doc: T) => Promise<void>
): Promise<Tally> {
  const tally: Tally = { name, source: docs.length, copied: 0, alreadyPresent: 0, failed: 0 };
  for (const doc of docs) {
    try {
      await write(doc.data() as T);
      tally.copied += 1;
    } catch (err) {
      if (isPrimaryKeyConflict(err)) {
        tally.alreadyPresent += 1;
      } else {
        tally.failed += 1;
        // The doc id, never the doc's own data — a ride or message body can
        // carry a phone number or a GPS trail, and this only needs to say
        // which row to go look at by hand.
        console.error(`  ✗ ${name}/${doc.id}: ${(err as Error).message}`);
      }
    }
  }
  return tally;
}

async function main(): Promise<void> {
  if (!initFirebase()) {
    throw new Error(
      'Firestore is not configured in this environment (FIREBASE_* env vars missing) — nothing to migrate from.'
    );
  }
  const sqlitePath = env.SQLITE_PATH ?? process.argv[2];
  if (!sqlitePath) {
    throw new Error('Set SQLITE_PATH, or pass a destination path as the first argument.');
  }
  console.log(`Destination: ${sqlitePath}`);
  const sqlite = new SqliteStore(sqlitePath);
  const db = getFirestore();

  const tallies: Tally[] = [];

  const usersSnap = await db.collection('users').get();
  tallies.push(await copyCollection<User>('users', usersSnap.docs, (u) => sqlite.saveUser(u)));

  const ridesSnap = await db.collection('rides').get();
  tallies.push(await copyCollection<Ride>('rides', ridesSnap.docs, (r) => sqlite.saveRide(r)));

  const paymentsSnap = await db.collection('payments').get();
  tallies.push(
    await copyCollection<Payment>('payments', paymentsSnap.docs, (p) => sqlite.savePayment(p))
  );

  const messagesSnap = await db.collection('messages').get();
  tallies.push(
    await copyCollection<Message>('messages', messagesSnap.docs, (m) => sqlite.saveMessage(m))
  );

  const pushTokensSnap = await db.collection('pushTokens').get();
  tallies.push(
    await copyCollection<PushToken>('pushTokens', pushTokensSnap.docs, (t) =>
      sqlite.savePushToken(t)
    )
  );

  const reportsSnap = await db.collection('reports').get();
  tallies.push(
    await copyCollection<Report>('reports', reportsSnap.docs, (r) => sqlite.addReport(r))
  );

  const settingsDoc = await db.collection('settings').doc('global').get();
  if (settingsDoc.exists) {
    await sqlite.updateSettings(settingsDoc.data() as Settings, 'firestore-migration');
    tallies.push({ name: 'settings', source: 1, copied: 1, alreadyPresent: 0, failed: 0 });
  } else {
    tallies.push({ name: 'settings', source: 0, copied: 0, alreadyPresent: 0, failed: 0 });
  }

  console.log('\n  collection        source   copied  already   failed');
  let anyFailed = false;
  for (const t of tallies) {
    if (t.failed > 0) anyFailed = true;
    console.log(
      `  ${t.name.padEnd(16)} ${String(t.source).padStart(6)} ${String(t.copied).padStart(8)} ${String(
        t.alreadyPresent
      ).padStart(9)} ${String(t.failed).padStart(8)}`
    );
  }

  const shortfall = tallies.some((t) => t.copied + t.alreadyPresent !== t.source);
  if (anyFailed || shortfall) {
    console.error('\nIncomplete — re-run once fixed; this is safe to repeat.');
    process.exit(1);
  }
  console.log('\nDone. Firestore was not modified.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
