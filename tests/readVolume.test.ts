import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';
import { store } from '../src/models';
import { nowIso } from '../src/utils/helpers';
import { forgetOnlineDrivers } from '../src/services/onlineDrivers';
import type { DriverInfo, User } from '../src/types';

// Firestore bills every read, and the free tier's daily allowance is a hard
// wall: hitting it makes the database answer `8 RESOURCE_EXHAUSTED` to
// everything until midnight Pacific, which is how the whole API went down in
// production. These endpoints are polled on timers by every phone with the app
// open, and each of them used to pay full price for an answer that was either
// identical to the last one or identical to the one another user had just been
// given. Sharing those reads is what keeps the app inside the allowance.
//
// NOTE: the caches live in module scope, so the cold-start assertions below run
// before anything else in this file touches the same endpoint. Order matters.

const app = createApp();

const adminAuth = { Authorization: `Bearer ${signToken({ uid: 'admin-reads', role: 'admin' })}` };

function auth(uid: string, role: 'driver' | 'passenger' = 'driver') {
  return { Authorization: `Bearer ${signToken({ uid, role })}` };
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

async function seedUser(uid: string, driverInfo?: DriverInfo): Promise<void> {
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

afterEach(() => jest.restoreAllMocks());

describe('open ride requests, polled by every driver on shift every 15 seconds', () => {
  it('are fetched once and handed to all of them', async () => {
    await seedUser('drv_open_a', { ...info });
    await seedUser('drv_open_b', { ...info });
    await seedUser('drv_open_c', { ...info });

    const query = jest.spyOn(store(), 'listAllRides');
    for (const uid of ['drv_open_a', 'drv_open_b', 'drv_open_c']) {
      const res = await request(app).get('/api/rides/open').set(auth(uid));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.rides)).toBe(true);
    }
    // Three drivers, three answers, one trip to the database. Without this the
    // bill for the endpoint grows with every driver who starts a shift.
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('the demand heatmap, which takes no parameters at all', () => {
  it('reads the window once rather than once per status', async () => {
    const query = jest.spyOn(store(), 'listRidesSince');
    const res = await request(app).get('/api/rides/heatmap').set(auth('drv_open_a'));
    expect(res.status).toBe(200);
    // It used to ask for 'searching' and 'cancelled' separately. Neither query
    // can filter status and a time range together without a composite index, so
    // both read the very same documents and each threw the other half away.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('is computed once and shared by every driver looking at it', async () => {
    const query = jest.spyOn(store(), 'listRidesSince');
    for (const uid of ['drv_open_a', 'drv_open_b', 'drv_open_c']) {
      expect((await request(app).get('/api/rides/heatmap').set(auth(uid))).status).toBe(200);
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe('the cars a passenger sees on the map', () => {
  it('cost one read of the driver list, not one per passenger', async () => {
    await seedUser('drv_map_1', { ...info, lastLocation: { lat: 52.23, lng: 21.01 } });
    await seedUser('drv_map_2', { ...info, lastLocation: { lat: 52.24, lng: 21.02 } });
    await seedUser('psg_map_1');
    forgetOnlineDrivers();

    const query = jest.spyOn(store(), 'listOnlineDrivers');
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .get('/api/drivers/nearby?lat=52.23&lng=21.01&radius=5')
        .set(auth('psg_map_1', 'passenger'));
      expect(res.status).toBe(200);
      // Shared, but still the real answer — not an empty list.
      expect(res.body.drivers.length).toBeGreaterThanOrEqual(2);
    }
    // This is the read that grows fastest as the app fills up: without sharing
    // it, the cost of the order screen is passengers multiplied by drivers.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('include a driver the moment they start their shift, not when the cache expires', async () => {
    // The list is warm from the test above, so an appearing car is exactly the
    // case a plain TTL would get wrong.
    await seedUser('drv_map_new', { ...info, isOnline: false, lastLocation: { lat: 52.23, lng: 21.01 } });

    const before = await request(app)
      .get('/api/drivers/nearby?lat=52.23&lng=21.01&radius=5')
      .set(auth('psg_map_1', 'passenger'));
    expect(before.body.drivers.map((d: { uid: string }) => d.uid)).not.toContain('drv_map_new');

    const online = await request(app)
      .post('/api/drivers/online')
      .set(auth('drv_map_new'))
      .send({ lat: 52.23, lng: 21.01 });
    expect(online.status).toBe(200);

    const after = await request(app)
      .get('/api/drivers/nearby?lat=52.23&lng=21.01&radius=5')
      .set(auth('psg_map_1', 'passenger'));
    expect(after.body.drivers.map((d: { uid: string }) => d.uid)).toContain('drv_map_new');
  });
});

describe('the "is this account blocked?" check on every single request', () => {
  it('stops re-reading the user document for a driver mid-shift', async () => {
    await seedUser('drv_blockcache', { ...info });
    // Warm it the way the first request of the shift would.
    expect((await request(app).get('/api/rides/open').set(auth('drv_blockcache'))).status).toBe(200);

    const reads = jest.spyOn(store(), 'getUser');
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/rides/open').set(auth('drv_blockcache'))).status).toBe(200);
    }
    // A driver on shift makes one of these roughly every four seconds. Paying a
    // read each time made this check the single largest consumer of the daily
    // quota in the whole app — to re-learn a flag that changes at most once in
    // an account's life.
    expect(reads).not.toHaveBeenCalled();
  });

  it('still shuts a banned account out on its very next request', async () => {
    await seedUser('drv_banned', { ...info });
    expect((await request(app).get('/api/rides/open').set(auth('drv_banned'))).status).toBe(200);

    const ban = await request(app)
      .patch('/api/admin/users/drv_banned')
      .set(adminAuth)
      .send({ isBlocked: true, blockReason: 'test' });
    expect(ban.status).toBe(200);

    // No waiting for the cache to age out: a ban that takes a minute to bite is
    // a ban the banned user can keep working through.
    const after = await request(app).get('/api/rides/open').set(auth('drv_banned'));
    expect(after.status).toBe(403);
    expect(after.body.code).toBe('BLOCKED');
  });

  it('lets a pardoned account straight back in', async () => {
    const lift = await request(app)
      .patch('/api/admin/users/drv_banned')
      .set(adminAuth)
      .send({ isBlocked: false });
    expect(lift.status).toBe(200);

    expect((await request(app).get('/api/rides/open').set(auth('drv_banned'))).status).toBe(200);
  });
});
