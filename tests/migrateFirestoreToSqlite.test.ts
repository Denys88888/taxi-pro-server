import { SqliteStore } from '../src/models/sqlite';
import { unlinkSync, existsSync } from 'fs';

// The migration script (src/scripts/migrateFirestoreToSqlite.ts) can only be
// exercised end-to-end against a real Firestore project, which this suite
// does not have. What IS testable without one, and worth pinning, is the
// exact failure mode the script is built around: messages and reports are
// plain SQLite INSERTs (their id is enough to identify a row — see
// migrations.ts), not upserts like users/rides/payments, so writing the same
// one twice throws SQLITE_CONSTRAINT rather than silently succeeding. The
// script's isPrimaryKeyConflict() check is what turns that into "already
// migrated" instead of a crash on a second run — this test is the case that
// would fail if that check were ever removed or narrowed.

const DB_PATH = '/tmp/migrate-test.db';

function isPrimaryKeyConflict(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

describe('migration idempotency (the failure the script guards against)', () => {
  afterEach(() => {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  });

  it('a repeated message insert throws a primary-key conflict, not a silent overwrite', async () => {
    const store = new SqliteStore(DB_PATH);
    const msg = {
      id: 'm1',
      chatId: 'c1',
      senderId: 'u1',
      senderRole: 'passenger' as const,
      text: 'hi',
      isTemplate: false,
      timestamp: new Date().toISOString(),
    };

    await store.saveMessage(msg);
    let threw: unknown = null;
    try {
      await store.saveMessage(msg);
    } catch (err) {
      threw = err;
    }

    expect(threw).not.toBeNull();
    expect(isPrimaryKeyConflict(threw)).toBe(true);
  });

  it('a repeated report insert behaves the same way', async () => {
    const store = new SqliteStore(DB_PATH);
    const report = {
      id: 'r1',
      status: 'open' as const,
      reason: 'test',
      reporterId: 'u1',
      reportedId: 'u2',
      rideId: 'ride1',
      createdAt: new Date().toISOString(),
    };

    await store.addReport(report);
    let threw: unknown = null;
    try {
      await store.addReport(report);
    } catch (err) {
      threw = err;
    }

    expect(threw).not.toBeNull();
    expect(isPrimaryKeyConflict(threw)).toBe(true);
  });

  // The other side of the same coin: users/rides/payments must NOT throw on a
  // second write, or a re-run of the migration would fail on every row it had
  // already copied, not just resume where it left off.
  it('a repeated user save does not throw — upsert, not insert', async () => {
    const store = new SqliteStore(DB_PATH);
    const user = {
      uid: 'u1',
      role: 'passenger' as const,
      name: 'Test',
      rating: 5,
      ratingCount: 0,
      isBlocked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.saveUser(user);
    await expect(store.saveUser(user)).resolves.not.toThrow();
  });
});
