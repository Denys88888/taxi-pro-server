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

export interface PaginatedRides {
  rides: Ride[];
  total: number;
  page: number;
  limit: number;
}

// A single persistence contract implemented by both the Firestore-backed store
// and the in-memory fallback, so the rest of the app is storage-agnostic.
export interface DataStore {
  // Users
  getUser(uid: string): Promise<User | null>;
  saveUser(user: User): Promise<void>;
  updateUser(uid: string, patch: Partial<User>): Promise<User | null>;
  listUsers(role?: Role): Promise<User[]>;
  listOnlineDrivers(): Promise<User[]>;

  // Rides
  getRide(id: string): Promise<Ride | null>;
  saveRide(ride: Ride): Promise<void>;
  updateRide(id: string, patch: Partial<Ride>): Promise<Ride | null>;
  listRidesByUser(
    uid: string,
    status: RideStatus | undefined,
    page: number,
    limit: number
  ): Promise<PaginatedRides>;
  listAllRides(status?: RideStatus): Promise<Ride[]>;

  // Messages
  getMessages(chatId: string): Promise<Message[]>;
  saveMessage(msg: Message): Promise<void>;

  // Payments
  getPayment(id: string): Promise<Payment | null>;
  savePayment(payment: Payment): Promise<void>;
  updatePayment(id: string, patch: Partial<Payment>): Promise<Payment | null>;

  // Push tokens
  savePushToken(token: PushToken): Promise<void>;
  getPushToken(userId: string): Promise<PushToken | null>;

  // Reports
  addReport(report: Report): Promise<void>;
  listReports(status?: Report['status']): Promise<Report[]>;
  updateReport(id: string, patch: Partial<Report>): Promise<Report | null>;

  // Settings (single global doc)
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>, updatedBy: string): Promise<Settings>;
}

// The active store is chosen at startup by initStore() in ./index.
let active: DataStore | null = null;

export function setStore(store: DataStore): void {
  active = store;
}

export function store(): DataStore {
  if (!active) throw new Error('Data store not initialized');
  return active;
}
