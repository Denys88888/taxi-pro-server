import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type {
  User,
  Ride,
  Message,
  Payment,
  PushToken,
  Report,
  Settings,
  Role,
  RideStatus,
} from '../types';
import { DEFAULT_SETTINGS } from '../config/constants';
import { nowIso, genId } from '../utils/helpers';
import { runMigrations } from './migrations';
import type { DataStore, PaginatedRides } from './store';

const SETTINGS_ID = 'global';

// SQLite-backed persistence (primary durable store). Rich objects are stored as
// JSON in a `data` column; filterable/sortable fields are also mirrored into
// typed columns. Uses WAL mode for concurrent reads + durable writes.
export class SqliteStore implements DataStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db);
  }

  get raw(): Database.Database {
    return this.db;
  }

  // ── Users ──────────────────────────────────────────────────────────────────
  private syncDriverProjection(user: User): void {
    if (!user.driverInfo) return;
    const d = user.driverInfo;
    this.db
      .prepare(
        `INSERT INTO drivers (uid, vehicle_type, license_verified, is_online, lat, lng, updated_at)
         VALUES (@uid, @vt, @lv, @on, @lat, @lng, @ts)
         ON CONFLICT(uid) DO UPDATE SET
           vehicle_type=@vt, license_verified=@lv, is_online=@on, lat=@lat, lng=@lng, updated_at=@ts`
      )
      .run({
        uid: user.uid,
        vt: d.vehicleType ?? null,
        lv: d.licenseVerified ? 1 : 0,
        on: d.isOnline ? 1 : 0,
        lat: d.lastLocation?.lat ?? null,
        lng: d.lastLocation?.lng ?? null,
        ts: nowIso(),
      });
  }

  async getUser(uid: string): Promise<User | null> {
    const row = this.db.prepare('SELECT data FROM users WHERE uid = ?').get(uid) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as User) : null;
  }

  async saveUser(user: User): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO users (uid, role, name, is_blocked, data, created_at, updated_at)
         VALUES (@uid, @role, @name, @blocked, @data, @created, @updated)
         ON CONFLICT(uid) DO UPDATE SET
           role=@role, name=@name, is_blocked=@blocked, data=@data, updated_at=@updated`
      )
      .run({
        uid: user.uid,
        role: user.role,
        name: user.name,
        blocked: user.isBlocked ? 1 : 0,
        data: JSON.stringify(user),
        created: user.createdAt,
        updated: user.updatedAt,
      });
    this.syncDriverProjection(user);
  }

  async updateUser(uid: string, patch: Partial<User>): Promise<User | null> {
    const existing = await this.getUser(uid);
    if (!existing) return null;
    const updated: User = { ...existing, ...patch, updatedAt: nowIso() };
    await this.saveUser(updated);
    return updated;
  }

  async listUsers(role?: Role): Promise<User[]> {
    const rows = (
      role
        ? this.db.prepare('SELECT data FROM users WHERE role = ?').all(role)
        : this.db.prepare('SELECT data FROM users').all()
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as User);
  }

  async listOnlineDrivers(): Promise<User[]> {
    const rows = this.db
      .prepare(
        `SELECT u.data FROM drivers d JOIN users u ON u.uid = d.uid
         WHERE d.is_online = 1 AND u.is_blocked = 0`
      )
      .all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as User);
  }

  // ── Rides ──────────────────────────────────────────────────────────────────
  async getRide(id: string): Promise<Ride | null> {
    const row = this.db.prepare('SELECT data FROM rides WHERE id = ?').get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Ride) : null;
  }

  async saveRide(ride: Ride): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO rides (id, passenger_id, driver_id, status, data, created_at, updated_at)
         VALUES (@id, @pid, @did, @status, @data, @created, @updated)
         ON CONFLICT(id) DO UPDATE SET
           driver_id=@did, status=@status, data=@data, updated_at=@updated`
      )
      .run({
        id: ride.id,
        pid: ride.passengerId,
        did: ride.driverId ?? null,
        status: ride.status,
        data: JSON.stringify(ride),
        created: ride.createdAt,
        updated: ride.updatedAt,
      });
  }

  async updateRide(id: string, patch: Partial<Ride>): Promise<Ride | null> {
    const existing = await this.getRide(id);
    if (!existing) return null;
    const updated: Ride = { ...existing, ...patch, updatedAt: nowIso() };
    await this.saveRide(updated);
    // Record ratings into their own table when a score is submitted.
    if (patch.driverRating && existing.driverId) {
      this.insertRating(id, existing.passengerId, existing.driverId, patch.driverRating, patch.driverReview);
    }
    if (patch.passengerRating && existing.driverId) {
      this.insertRating(id, existing.driverId, existing.passengerId, patch.passengerRating, patch.passengerReview);
    }
    return updated;
  }

  private insertRating(rideId: string, from: string, to: string, score: number, comment?: string): void {
    this.db
      .prepare(
        `INSERT INTO ratings (id, ride_id, from_uid, to_uid, score, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(genId('rating'), rideId, from, to, score, comment ?? null, nowIso());
  }

  async listRidesByUser(
    uid: string,
    status: RideStatus | undefined,
    page: number,
    limit: number
  ): Promise<PaginatedRides> {
    const where = status
      ? '(passenger_id = @uid OR driver_id = @uid) AND status = @status'
      : '(passenger_id = @uid OR driver_id = @uid)';
    const total = (
      this.db.prepare(`SELECT COUNT(*) c FROM rides WHERE ${where}`).get({ uid, status }) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT data FROM rides WHERE ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
      )
      .all({ uid, status, limit, offset: (page - 1) * limit }) as { data: string }[];
    return { rides: rows.map((r) => JSON.parse(r.data) as Ride), total, page, limit };
  }

  async listAllRides(status?: RideStatus): Promise<Ride[]> {
    const rows = (
      status
        ? this.db
            .prepare('SELECT data FROM rides WHERE status = ? ORDER BY created_at DESC')
            .all(status)
        : this.db.prepare('SELECT data FROM rides ORDER BY created_at DESC').all()
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Ride);
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  async getMessages(chatId: string): Promise<Message[]> {
    const rows = this.db
      .prepare('SELECT data FROM messages WHERE chat_id = ? ORDER BY timestamp ASC')
      .all(chatId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Message);
  }

  async saveMessage(msg: Message): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages (id, chat_id, sender_id, data, timestamp)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(msg.id, msg.chatId, msg.senderId, JSON.stringify(msg), msg.timestamp);
  }

  // ── Payments ───────────────────────────────────────────────────────────────
  async getPayment(id: string): Promise<Payment | null> {
    const row = this.db.prepare('SELECT data FROM payments WHERE id = ?').get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Payment) : null;
  }

  async savePayment(payment: Payment): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO payments (id, ride_id, status, data, created_at, updated_at)
         VALUES (@id, @rid, @status, @data, @created, @updated)
         ON CONFLICT(id) DO UPDATE SET status=@status, data=@data, updated_at=@updated`
      )
      .run({
        id: payment.id,
        rid: payment.rideId,
        status: payment.status,
        data: JSON.stringify(payment),
        created: payment.createdAt,
        updated: payment.updatedAt,
      });
  }

  async updatePayment(id: string, patch: Partial<Payment>): Promise<Payment | null> {
    const existing = await this.getPayment(id);
    if (!existing) return null;
    const updated: Payment = { ...existing, ...patch, updatedAt: nowIso() };
    await this.savePayment(updated);
    return updated;
  }

  // ── Push tokens ────────────────────────────────────────────────────────────
  async savePushToken(token: PushToken): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO push_tokens (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
      )
      .run(token.userId, JSON.stringify(token), token.updatedAt);
  }

  async getPushToken(userId: string): Promise<PushToken | null> {
    const row = this.db.prepare('SELECT data FROM push_tokens WHERE user_id = ?').get(userId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as PushToken) : null;
  }

  // ── Reports ────────────────────────────────────────────────────────────────
  async addReport(report: Report): Promise<void> {
    this.db
      .prepare('INSERT INTO reports (id, status, data, created_at) VALUES (?, ?, ?, ?)')
      .run(report.id, report.status, JSON.stringify(report), report.createdAt);
  }

  async listReports(status?: Report['status']): Promise<Report[]> {
    const rows = (
      status
        ? this.db
            .prepare('SELECT data FROM reports WHERE status = ? ORDER BY created_at DESC')
            .all(status)
        : this.db.prepare('SELECT data FROM reports ORDER BY created_at DESC').all()
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Report);
  }

  async updateReport(id: string, patch: Partial<Report>): Promise<Report | null> {
    const row = this.db.prepare('SELECT data FROM reports WHERE id = ?').get(id) as
      | { data: string }
      | undefined;
    if (!row) return null;
    const updated: Report = { ...(JSON.parse(row.data) as Report), ...patch };
    this.db
      .prepare('UPDATE reports SET status = ?, data = ? WHERE id = ?')
      .run(updated.status, JSON.stringify(updated), id);
    return updated;
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  async getSettings(): Promise<Settings> {
    const row = this.db.prepare('SELECT data FROM settings WHERE id = ?').get(SETTINGS_ID) as
      | { data: string }
      | undefined;
    if (!row) {
      this.db
        .prepare('INSERT INTO settings (id, data) VALUES (?, ?)')
        .run(SETTINGS_ID, JSON.stringify(DEFAULT_SETTINGS));
      return { ...DEFAULT_SETTINGS };
    }
    return JSON.parse(row.data) as Settings;
  }

  async updateSettings(patch: Partial<Settings>, updatedBy: string): Promise<Settings> {
    const current = await this.getSettings();
    const updated: Settings = { ...current, ...patch, updatedBy, updatedAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO settings (id, data) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data`
      )
      .run(SETTINGS_ID, JSON.stringify(updated));
    return updated;
  }
}
