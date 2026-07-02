import type Database from 'better-sqlite3';

// SQLite schema. Rich/nested fields are stored as JSON in a `data` column; the
// columns pulled out alongside are the ones we filter or sort on. Idempotent
// (CREATE TABLE IF NOT EXISTS) so it doubles as the migration runner.
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      uid            TEXT PRIMARY KEY,
      role           TEXT NOT NULL,
      name           TEXT,
      is_blocked     INTEGER NOT NULL DEFAULT 0,
      data           TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

    -- Driver-specific projection (verification + live availability), keyed by uid.
    CREATE TABLE IF NOT EXISTS drivers (
      uid              TEXT PRIMARY KEY,
      vehicle_type     TEXT,
      license_verified INTEGER NOT NULL DEFAULT 0,
      is_online        INTEGER NOT NULL DEFAULT 0,
      lat              REAL,
      lng              REAL,
      updated_at       TEXT NOT NULL,
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_drivers_online ON drivers(is_online);

    CREATE TABLE IF NOT EXISTS rides (
      id             TEXT PRIMARY KEY,
      passenger_id   TEXT NOT NULL,
      driver_id      TEXT,
      status         TEXT NOT NULL,
      data           TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rides_passenger ON rides(passenger_id);
    CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id);
    CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);

    CREATE TABLE IF NOT EXISTS payments (
      id             TEXT PRIMARY KEY,
      ride_id        TEXT,
      status         TEXT NOT NULL,
      data           TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id             TEXT PRIMARY KEY,
      chat_id        TEXT NOT NULL,
      sender_id      TEXT NOT NULL,
      data           TEXT NOT NULL,
      timestamp      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);

    CREATE TABLE IF NOT EXISTS ratings (
      id             TEXT PRIMARY KEY,
      ride_id        TEXT NOT NULL,
      from_uid       TEXT NOT NULL,
      to_uid         TEXT NOT NULL,
      score          INTEGER NOT NULL,
      comment        TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ratings_to ON ratings(to_uid);

    CREATE TABLE IF NOT EXISTS push_tokens (
      user_id        TEXT PRIMARY KEY,
      data           TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id             TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      data           TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

    CREATE TABLE IF NOT EXISTS settings (
      id             TEXT PRIMARY KEY,
      data           TEXT NOT NULL
    );
  `);
}
