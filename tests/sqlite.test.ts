import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteStore } from '../src/models/sqlite';
import { nowIso } from '../src/utils/helpers';
import type { User, Ride } from '../src/types';

const tmp = path.join(os.tmpdir(), `taxipro-test-${Date.now()}.db`);

function mkUser(uid: string, role: User['role'] = 'passenger'): User {
  return {
    uid,
    role,
    name: uid,
    rating: 5,
    ratingCount: 0,
    isBlocked: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}
function mkRide(id: string, passengerId: string): Ride {
  return {
    id,
    passengerId,
    pickup: { lat: 52.23, lng: 21.01 },
    destination: { lat: 52.2, lng: 21.05 },
    vehicleType: 'economy',
    distanceKm: 5,
    estimatedDurationMin: 10,
    fare: 4,
    platformFeePercent: 10,
    platformFee: 0.4,
    driverEarnings: 3.6,
    status: 'searching',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(tmp + suffix);
    } catch {
      /* ignore */
    }
  }
});

describe('SqliteStore', () => {
  it('runs migrations creating all six core tables + WAL mode', () => {
    const store = new SqliteStore(tmp);
    const tables = (
      store.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of ['users', 'rides', 'payments', 'messages', 'drivers', 'ratings']) {
      expect(tables).toContain(t);
    }
    expect(String(store.raw.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    store.raw.close();
  });

  it('persists data across store reopen (durable)', async () => {
    const store1 = new SqliteStore(tmp);
    await store1.saveUser(mkUser('u-persist'));
    await store1.saveRide(mkRide('r-persist', 'u-persist'));
    store1.raw.close();

    // Reopen a fresh store on the same file — data must still be there.
    const store2 = new SqliteStore(tmp);
    const user = await store2.getUser('u-persist');
    const ride = await store2.getRide('r-persist');
    expect(user?.uid).toBe('u-persist');
    expect(ride?.id).toBe('r-persist');
    store2.raw.close();
  });

  it('projects online drivers and records ratings', async () => {
    const store = new SqliteStore(tmp);
    const driver: User = {
      ...mkUser('d-sql', 'driver'),
      driverInfo: {
        vehicleType: 'comfort',
        brand: 'Toyota',
        model: 'Camry',
        color: 'Silver',
        number: 'WX 1',
        vehicleYear: 2020,
        licenseVerified: true,
        isOnline: true,
        lastLocation: { lat: 52.23, lng: 21.01 },
      },
    };
    await store.saveUser(driver);
    await store.saveUser(mkUser('p-sql'));
    const online = await store.listOnlineDrivers();
    expect(online.map((u) => u.uid)).toContain('d-sql');

    await store.saveRide({ ...mkRide('r-rate', 'p-sql'), driverId: 'd-sql', status: 'completed' });
    await store.updateRide('r-rate', { driverRating: 4 });
    const rating = store.raw
      .prepare('SELECT score, to_uid FROM ratings WHERE ride_id = ?')
      .get('r-rate') as { score: number; to_uid: string } | undefined;
    expect(rating?.score).toBe(4);
    expect(rating?.to_uid).toBe('d-sql');
    store.raw.close();
  });
});
