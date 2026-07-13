import type * as adminNs from 'firebase-admin';
import { getFirestore } from '../config/firebase';
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

const SETTINGS_DOC = 'global';

// Firestore-backed persistence. Collections and field names follow the schema in
// the project spec. Uses update() (not set) for partial patches so we never
// clobber unrelated fields on a concurrent write.
export class FirestoreStore implements DataStore {
  private db(): adminNs.firestore.Firestore {
    return getFirestore();
  }

  async getUser(uid: string): Promise<User | null> {
    const snap = await this.db().collection('users').doc(uid).get();
    return snap.exists ? (snap.data() as User) : null;
  }
  async saveUser(user: User): Promise<void> {
    await this.db().collection('users').doc(user.uid).set(user);
  }
  async updateUser(uid: string, patch: Partial<User>): Promise<User | null> {
    const ref = this.db().collection('users').doc(uid);
    await ref.update({ ...patch, updatedAt: nowIso() });
    const snap = await ref.get();
    return snap.exists ? (snap.data() as User) : null;
  }
  async listUsers(role?: Role): Promise<User[]> {
    let q: adminNs.firestore.Query = this.db().collection('users');
    if (role) q = q.where('role', '==', role);
    const snap = await q.get();
    return snap.docs.map((d) => d.data() as User);
  }
  async listOnlineDrivers(): Promise<User[]> {
    const snap = await this.db()
      .collection('users')
      .where('role', '==', 'driver')
      .where('driverInfo.isOnline', '==', true)
      .get();
    return snap.docs.map((d) => d.data() as User).filter((u) => !u.isBlocked);
  }

  async getRide(id: string): Promise<Ride | null> {
    const snap = await this.db().collection('rides').doc(id).get();
    return snap.exists ? (snap.data() as Ride) : null;
  }
  async saveRide(ride: Ride): Promise<void> {
    await this.db().collection('rides').doc(ride.id).set(ride);
  }
  async updateRide(id: string, patch: Partial<Ride>): Promise<Ride | null> {
    const ref = this.db().collection('rides').doc(id);
    await ref.update({ ...patch, updatedAt: nowIso() });
    const snap = await ref.get();
    return snap.exists ? (snap.data() as Ride) : null;
  }
  async listRidesByUser(
    uid: string,
    status: RideStatus | undefined,
    page: number,
    limit: number
  ): Promise<PaginatedRides> {
    // Firestore cannot OR across fields, so fetch passenger + driver rides and merge.
    const [asPassenger, asDriver] = await Promise.all([
      this.db().collection('rides').where('passengerId', '==', uid).get(),
      this.db().collection('rides').where('driverId', '==', uid).get(),
    ]);
    const map = new Map<string, Ride>();
    for (const d of [...asPassenger.docs, ...asDriver.docs]) {
      map.set(d.id, d.data() as Ride);
    }
    let list = Array.from(map.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    if (status) list = list.filter((r) => r.status === status);
    const total = list.length;
    const start = (page - 1) * limit;
    return { rides: list.slice(start, start + limit), total, page, limit };
  }
  async listAllRides(status?: RideStatus): Promise<Ride[]> {
    // status + orderBy(createdAt) needs a composite index Firestore doesn't
    // have; filter server-side and sort in memory so the scheduler never dies.
    let q: adminNs.firestore.Query = this.db().collection('rides');
    q = status ? q.where('status', '==', status) : q.orderBy('createdAt', 'desc');
    const snap = await q.get();
    const rides = snap.docs.map((d) => d.data() as Ride);
    return status ? rides.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : rides;
  }

  async getMessages(chatId: string): Promise<Message[]> {
    // No orderBy alongside where — that combination requires a composite index
    // (same failure class as listAllRides); sort in memory instead.
    const snap = await this.db()
      .collection('messages')
      .where('chatId', '==', chatId)
      .get();
    return snap.docs
      .map((d) => d.data() as Message)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  async saveMessage(msg: Message): Promise<void> {
    await this.db().collection('messages').doc(msg.id).set(msg);
  }

  async getPayment(id: string): Promise<Payment | null> {
    const snap = await this.db().collection('payments').doc(id).get();
    return snap.exists ? (snap.data() as Payment) : null;
  }
  async savePayment(payment: Payment): Promise<void> {
    await this.db().collection('payments').doc(payment.id).set(payment);
  }
  async updatePayment(id: string, patch: Partial<Payment>): Promise<Payment | null> {
    const ref = this.db().collection('payments').doc(id);
    await ref.update({ ...patch, updatedAt: nowIso() });
    const snap = await ref.get();
    return snap.exists ? (snap.data() as Payment) : null;
  }

  async savePushToken(token: PushToken): Promise<void> {
    await this.db().collection('pushTokens').doc(token.userId).set(token);
  }
  async getPushToken(userId: string): Promise<PushToken | null> {
    const snap = await this.db().collection('pushTokens').doc(userId).get();
    return snap.exists ? (snap.data() as PushToken) : null;
  }

  async addReport(report: Report): Promise<void> {
    await this.db().collection('reports').doc(report.id).set(report);
  }
  async listReports(status?: Report['status']): Promise<Report[]> {
    // where + orderBy needs a composite index — filter only, sort in memory.
    let q: adminNs.firestore.Query = this.db().collection('reports');
    q = status ? q.where('status', '==', status) : q.orderBy('createdAt', 'desc');
    const snap = await q.get();
    const reports = snap.docs.map((d) => d.data() as Report);
    return status ? reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : reports;
  }
  async updateReport(id: string, patch: Partial<Report>): Promise<Report | null> {
    const ref = this.db().collection('reports').doc(id);
    await ref.update(patch);
    const snap = await ref.get();
    return snap.exists ? (snap.data() as Report) : null;
  }

  async getSettings(): Promise<Settings> {
    const snap = await this.db().collection('settings').doc(SETTINGS_DOC).get();
    if (!snap.exists) {
      await this.db().collection('settings').doc(SETTINGS_DOC).set(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS };
    }
    return snap.data() as Settings;
  }
  async updateSettings(patch: Partial<Settings>, updatedBy: string): Promise<Settings> {
    const ref = this.db().collection('settings').doc(SETTINGS_DOC);
    await ref.set(
      { ...patch, updatedBy, updatedAt: nowIso() },
      { merge: true }
    );
    const snap = await ref.get();
    return snap.data() as Settings;
  }
}
