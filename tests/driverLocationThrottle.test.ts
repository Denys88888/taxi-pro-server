import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';
import { store } from '../src/models';
import { nowIso } from '../src/utils/helpers';
import { forgetDriverLocation } from '../src/services/driverLocation';
import type { DriverInfo, User } from '../src/types';

// A driver online reports their position every 30 seconds, over REST and over
// the socket both, and each report used to cost a read plus a write. Idle
// overnight that is more Firestore operations than the free tier grants in a
// day — and the quota running out is what crashed the whole API. Dispatch reads
// the socket's in-memory copy, so the stored one is allowed to lag.

const app = createApp();

function auth(uid: string) {
  return { Authorization: `Bearer ${signToken({ uid, role: 'driver' })}` };
}

async function seedDriver(uid: string, driverInfo?: DriverInfo): Promise<void> {
  await store().saveUser({
    uid,
    role: driverInfo ? 'driver' : 'passenger',
    name: uid,
    rating: 5,
    ratingCount: 0,
    isBlocked: false,
    driverInfo,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as User);
}

const info: DriverInfo = {
  vehicleType: 'economy',
  brand: 'Toyota',
  model: 'Prius',
  color: 'White',
  number: 'AA1234BB',
  vehicleYear: 2018,
  licenseVerified: true,
  applicationStatus: 'approved',
  isOnline: true,
};

describe('a parked driver pinging their position', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is written once, not on every ping', async () => {
    const uid = 'drv_throttle_still';
    forgetDriverLocation(uid);
    await seedDriver(uid, { ...info });

    const first = await request(app).post('/api/drivers/location').set(auth(uid)).send({ lat: 52.23, lng: 21.01 });
    expect(first.status).toBe(200);

    const writes = jest.spyOn(store(), 'updateUser');
    // Same corner, a few metres of GPS jitter apart — the next three pings.
    for (const lng of [21.0101, 21.0099, 21.01]) {
      const res = await request(app).post('/api/drivers/location').set(auth(uid)).send({ lat: 52.23, lng });
      expect(res.status).toBe(200);
      expect(res.body.lastLocation).toEqual({ lat: 52.23, lng });
    }
    expect(writes).not.toHaveBeenCalled();

    // …and the stored position is still the one from the first ping.
    const stored = await store().getUser(uid);
    expect(stored?.driverInfo?.lastLocation).toEqual({ lat: 52.23, lng: 21.01 });
  });

  it('is written straight away once the car has actually moved', async () => {
    const uid = 'drv_throttle_moving';
    forgetDriverLocation(uid);
    await seedDriver(uid, { ...info });

    await request(app).post('/api/drivers/location').set(auth(uid)).send({ lat: 52.23, lng: 21.01 });
    // ~1.5 km down the road — a passenger's map must not still show the car
    // back at the start.
    const moved = await request(app).post('/api/drivers/location').set(auth(uid)).send({ lat: 52.243, lng: 21.01 });

    expect(moved.status).toBe(200);
    const stored = await store().getUser(uid);
    expect(stored?.driverInfo?.lastLocation).toEqual({ lat: 52.243, lng: 21.01 });
  });

  it('still refuses an account that is not a driver at all', async () => {
    const uid = 'drv_throttle_notadriver';
    forgetDriverLocation(uid);
    await seedDriver(uid);

    const res = await request(app).post('/api/drivers/location').set(auth(uid)).send({ lat: 52.23, lng: 21.01 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Not a driver');
  });

  it('writes the first position of a new shift instead of inheriting the last one', async () => {
    const uid = 'drv_throttle_newshift';
    forgetDriverLocation(uid);
    await seedDriver(uid, { ...info });

    await request(app).post('/api/drivers/location').set(auth(uid)).send({ lat: 52.23, lng: 21.01 });
    // Going offline ends the skip window; the store must not be left holding
    // yesterday's parking spot when they come back on.
    await request(app).post('/api/drivers/offline').set(auth(uid)).send({});

    const writes = jest.spyOn(store(), 'updateUser');
    await request(app).post('/api/drivers/location').set(auth(uid)).send({ lat: 52.2301, lng: 21.0101 });

    expect(writes).toHaveBeenCalled();
  });
});
