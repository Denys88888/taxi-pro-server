import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteStore } from '../src/models/sqlite';
import { MemoryStore } from '../src/models/memory';
import type { DataStore } from '../src/models/store';
import type { Ride, RideStatus } from '../src/types';

// The dashboard counters and the heatmap moved from "read every ride, then
// filter/count in JS" to backend-side aggregates and time-bounded queries.
// These cover the part that regressions would be silent about: the aggregates
// must agree with the straightforward in-JS computation they replaced, and the
// time filter must not be off by a boundary.

const tmp = path.join(os.tmpdir(), `taxipro-stats-${Date.now()}.db`);

function mkRide(id: string, status: RideStatus, createdAt: string, platformFee = 0.4): Ride {
  return {
    id,
    passengerId: `p_${id}`,
    pickup: { lat: 52.23, lng: 21.01 },
    destination: { lat: 52.2, lng: 21.05 },
    vehicleType: 'economy',
    distanceKm: 5,
    estimatedDurationMin: 10,
    fare: 4,
    platformFeePercent: 10,
    platformFee,
    driverEarnings: 4 - platformFee,
    status,
    createdAt,
    updatedAt: createdAt,
  };
}

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

// Mixed ages and statuses, including completed rides on both sides of every
// window the callers use.
const fixtures: Ride[] = [
  mkRide('r_fresh_searching', 'searching', iso(5 * MIN)),
  mkRide('r_fresh_cancelled', 'cancelled', iso(10 * MIN)),
  mkRide('r_old_cancelled', 'cancelled', iso(3 * DAY)),
  mkRide('r_done_recent', 'completed', iso(2 * DAY), 0.5),
  mkRide('r_done_older', 'completed', iso(20 * DAY), 0.25),
  mkRide('r_done_ancient', 'completed', iso(400 * DAY), 1.25),
];

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(tmp + suffix);
    } catch {
      /* ignore */
    }
  }
});

async function seed(store: DataStore): Promise<void> {
  for (const r of fixtures) await store.saveRide(r);
}

describe.each<[string, () => DataStore]>([
  ['MemoryStore', () => new MemoryStore()],
  ['SqliteStore', () => new SqliteStore(tmp)],
])('%s ride aggregates', (_name, make) => {
  let store: DataStore;

  beforeAll(async () => {
    store = make();
    await seed(store);
  });

  it('rideStats matches counting and summing every ride by hand', async () => {
    const all = await store.listAllRides();
    const completed = all.filter((r) => r.status === 'completed');
    const expectedFee = completed.reduce((s, r) => s + (r.platformFee || 0), 0);

    const stats = await store.rideStats();
    expect(stats.total).toBe(all.length);
    expect(stats.completed).toBe(completed.length);
    expect(stats.platformEarnings).toBeCloseTo(expectedFee, 6);
  });

  it('rideStats sums only completed rides, not every ride', async () => {
    const stats = await store.rideStats();
    // 0.5 + 0.25 + 1.25; the searching/cancelled fees must not leak in.
    expect(stats.platformEarnings).toBeCloseTo(2.0, 6);
    expect(stats.completed).toBe(3);
    expect(stats.total).toBe(fixtures.length);
  });

  it('listRidesSince respects the window the heatmap uses (30 min)', async () => {
    const since = iso(30 * MIN);
    const searching = await store.listRidesSince(since, 'searching');
    const cancelled = await store.listRidesSince(since, 'cancelled');

    expect(searching.map((r) => r.id)).toEqual(['r_fresh_searching']);
    // The 3-day-old cancelled ride is exactly what used to be read and thrown away.
    expect(cancelled.map((r) => r.id)).toEqual(['r_fresh_cancelled']);
  });

  it('listRidesSince without a status returns every ride in the window', async () => {
    const within14d = await store.listRidesSince(iso(14 * DAY));
    expect(within14d.map((r) => r.id).sort()).toEqual(
      ['r_done_recent', 'r_fresh_cancelled', 'r_fresh_searching', 'r_old_cancelled'].sort()
    );
    expect(within14d.some((r) => r.id === 'r_done_ancient')).toBe(false);
  });

  it('listRidesSince returns newest first', async () => {
    const rides = await store.listRidesSince(iso(500 * DAY));
    const dates = rides.map((r) => r.createdAt);
    expect([...dates].sort((a, b) => b.localeCompare(a))).toEqual(dates);
  });

  it('listRidesSince is inclusive of a ride created exactly at the boundary', async () => {
    const boundary = fixtures.find((r) => r.id === 'r_done_recent')!.createdAt;
    const rides = await store.listRidesSince(boundary);
    expect(rides.map((r) => r.id)).toContain('r_done_recent');
  });
});
