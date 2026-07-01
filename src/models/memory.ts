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
import { nowIso } from '../utils/helpers';
import type { DataStore, PaginatedRides } from './store';

// In-memory fallback used when Firebase is not configured or unavailable.
// State is per-process and non-durable; suitable for local dev, CI, and as a
// graceful-degradation safety net (Rule 7).
export class MemoryStore implements DataStore {
  private users = new Map<string, User>();
  private rides = new Map<string, Ride>();
  private messages = new Map<string, Message[]>();
  private payments = new Map<string, Payment>();
  private pushTokens = new Map<string, PushToken>();
  private reports = new Map<string, Report>();
  private settings: Settings = { ...DEFAULT_SETTINGS };

  async getUser(uid: string): Promise<User | null> {
    return this.users.get(uid) ?? null;
  }
  async saveUser(user: User): Promise<void> {
    this.users.set(user.uid, user);
  }
  async updateUser(uid: string, patch: Partial<User>): Promise<User | null> {
    const existing = this.users.get(uid);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: nowIso() };
    this.users.set(uid, updated);
    return updated;
  }
  async listUsers(role?: Role): Promise<User[]> {
    const all = Array.from(this.users.values());
    return role ? all.filter((u) => u.role === role) : all;
  }
  async listOnlineDrivers(): Promise<User[]> {
    return Array.from(this.users.values()).filter(
      (u) => u.role === 'driver' && u.driverInfo?.isOnline && !u.isBlocked
    );
  }

  async getRide(id: string): Promise<Ride | null> {
    return this.rides.get(id) ?? null;
  }
  async saveRide(ride: Ride): Promise<void> {
    this.rides.set(ride.id, ride);
  }
  async updateRide(id: string, patch: Partial<Ride>): Promise<Ride | null> {
    const existing = this.rides.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: nowIso() };
    this.rides.set(id, updated);
    return updated;
  }
  async listRidesByUser(
    uid: string,
    status: RideStatus | undefined,
    page: number,
    limit: number
  ): Promise<PaginatedRides> {
    let list = Array.from(this.rides.values())
      .filter((r) => r.passengerId === uid || r.driverId === uid)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (status) list = list.filter((r) => r.status === status);
    const total = list.length;
    const start = (page - 1) * limit;
    return { rides: list.slice(start, start + limit), total, page, limit };
  }
  async listAllRides(status?: RideStatus): Promise<Ride[]> {
    const list = Array.from(this.rides.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    return status ? list.filter((r) => r.status === status) : list;
  }

  async getMessages(chatId: string): Promise<Message[]> {
    return this.messages.get(chatId) ?? [];
  }
  async saveMessage(msg: Message): Promise<void> {
    const list = this.messages.get(msg.chatId) ?? [];
    list.push(msg);
    this.messages.set(msg.chatId, list);
  }

  async getPayment(id: string): Promise<Payment | null> {
    return this.payments.get(id) ?? null;
  }
  async savePayment(payment: Payment): Promise<void> {
    this.payments.set(payment.id, payment);
  }
  async updatePayment(id: string, patch: Partial<Payment>): Promise<Payment | null> {
    const existing = this.payments.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: nowIso() };
    this.payments.set(id, updated);
    return updated;
  }

  async savePushToken(token: PushToken): Promise<void> {
    this.pushTokens.set(token.userId, token);
  }
  async getPushToken(userId: string): Promise<PushToken | null> {
    return this.pushTokens.get(userId) ?? null;
  }

  async addReport(report: Report): Promise<void> {
    this.reports.set(report.id, report);
  }
  async listReports(status?: Report['status']): Promise<Report[]> {
    const list = Array.from(this.reports.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    return status ? list.filter((r) => r.status === status) : list;
  }
  async updateReport(id: string, patch: Partial<Report>): Promise<Report | null> {
    const existing = this.reports.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.reports.set(id, updated);
    return updated;
  }

  async getSettings(): Promise<Settings> {
    return this.settings;
  }
  async updateSettings(patch: Partial<Settings>, updatedBy: string): Promise<Settings> {
    this.settings = { ...this.settings, ...patch, updatedBy, updatedAt: nowIso() };
    return this.settings;
  }
}
