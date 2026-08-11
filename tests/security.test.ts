import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';
import { store } from '../src/models';
import { nowIso } from '../src/utils/helpers';
import type { DriverInfo, Ride, User } from '../src/types';

// Regression guards for the authorization / integrity fixes made during the
// 2026-07-07 hardening pass. Each test pins a specific defect closed.

const app = createApp();
const auth = (uid: string, role: 'passenger' | 'driver' | 'admin' = 'passenger') => ({
  Authorization: `Bearer ${signToken({ uid, role })}`,
});
const pickup = { lat: 52.23, lng: 21.01, address: 'A' };
const destination = { lat: 52.2, lng: 21.05, address: 'B' };

async function seedUser(u: Partial<User> & { uid: string; role: User['role'] }): Promise<void> {
  await store().saveUser({
    name: u.uid, rating: 5, ratingCount: 0, isBlocked: false,
    createdAt: nowIso(), updatedAt: nowIso(), ...u,
  } as User);
}
const approvedDriverInfo: DriverInfo = {
  vehicleType: 'economy', brand: 'T', model: 'P', color: 'w', number: 'W1', vehicleYear: 2018,
  licenseVerified: true, applicationStatus: 'approved', isOnline: true,
};
async function seedRide(r: Partial<Ride> & { id: string; passengerId: string }): Promise<void> {
  const now = nowIso();
  await store().saveRide({
    pickup, destination, vehicleType: 'economy', distanceKm: 3, estimatedDurationMin: 8,
    fare: 5, platformFeePercent: 10, platformFee: 0.5, driverEarnings: 4.5,
    surgeMultiplier: 1, paymentStatus: 'pending', status: 'searching',
    createdAt: now, updatedAt: now, ...r,
  } as Ride);
}

describe('rating authorization', () => {
  it('lets a passenger rate the driver on a completed ride', async () => {
    await seedUser({ uid: 'r-pass', role: 'passenger' });
    await seedUser({ uid: 'r-drv', role: 'driver' });
    await seedRide({ id: 'r-ride', passengerId: 'r-pass', driverId: 'r-drv', status: 'completed' });
    const res = await request(app).patch('/api/rides/r-ride').set(auth('r-pass')).send({ driverRating: 5 });
    expect(res.status).toBe(200);
  });

  it('forbids a driver from setting their own driverRating', async () => {
    await seedUser({ uid: 'r2-pass', role: 'passenger' });
    await seedUser({ uid: 'r2-drv', role: 'driver' });
    await seedRide({ id: 'r2-ride', passengerId: 'r2-pass', driverId: 'r2-drv', status: 'completed' });
    const res = await request(app).patch('/api/rides/r2-ride').set(auth('r2-drv', 'driver')).send({ driverRating: 1 });
    expect([400, 403]).toContain(res.status);
  });

  it('forbids rating a ride that is not completed', async () => {
    await seedUser({ uid: 'r3-pass', role: 'passenger' });
    await seedRide({ id: 'r3-ride', passengerId: 'r3-pass', driverId: 'r3-drv', status: 'assigned' });
    const res = await request(app).patch('/api/rides/r3-ride').set(auth('r3-pass')).send({ driverRating: 5 });
    expect(res.status).toBe(409);
  });
});

describe('fare-offer authorization', () => {
  it('forbids a passenger from submitting an offer', async () => {
    await seedUser({ uid: 'o-pass', role: 'passenger' });
    await seedRide({ id: 'o-ride', passengerId: 'o-owner', negotiable: true });
    const res = await request(app).post('/api/rides/o-ride/offers').set(auth('o-pass')).send({ amount: 4 });
    expect(res.status).toBe(403);
  });

  it('forbids an unapproved driver from submitting an offer', async () => {
    await seedUser({ uid: 'o-drv-unapp', role: 'driver' }); // no driverInfo
    await seedRide({ id: 'o-ride2', passengerId: 'o-owner', negotiable: true });
    const res = await request(app).post('/api/rides/o-ride2/offers').set(auth('o-drv-unapp', 'driver')).send({ amount: 4 });
    expect(res.status).toBe(403);
  });

  it('lets an approved driver submit an offer', async () => {
    await seedUser({ uid: 'o-drv-ok', role: 'driver', driverInfo: approvedDriverInfo });
    await seedRide({ id: 'o-ride3', passengerId: 'o-owner', negotiable: true });
    const res = await request(app).post('/api/rides/o-ride3/offers').set(auth('o-drv-ok', 'driver')).send({ amount: 6 });
    expect(res.status).toBe(201);
  });
});

describe('one active ride per passenger', () => {
  it('rejects a second concurrent ride with 409', async () => {
    const a = auth('one-ride-pass');
    const first = await request(app).post('/api/rides').set(a).send({ pickup, destination, vehicleType: 'economy' });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/rides').set(a).send({ pickup, destination, vehicleType: 'economy' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ACTIVE_RIDE_EXISTS');
  });
});

describe('block enforcement after login', () => {
  it('rejects a blocked user with 403 despite a valid JWT', async () => {
    await seedUser({ uid: 'blocked-1', role: 'passenger', isBlocked: true, blockReason: 'test' });
    const res = await request(app).get('/api/users/me').set(auth('blocked-1'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BLOCKED');
  });

  it('lets a non-blocked user through', async () => {
    await seedUser({ uid: 'ok-1', role: 'passenger' });
    const res = await request(app).get('/api/users/me').set(auth('ok-1'));
    expect(res.status).toBe(200);
  });
});

// 2026-08-11 sweep: payment endpoints checked ownership as
// `if (ride && ride.passengerId !== uid)`, which a missed ride lookup
// short-circuited past entirely — the same shape that left chat history
// readable. getPayment had no ownership check at all. Rides are never
// hard-deleted today so the short-circuit isn't reachable through a real
// ride, but getPayment was live: any authenticated user could read any
// payment record (amount, fees, driver earnings, txid, Pi payment id) given
// its id, with only the rate limiter in the way.
describe('payment authorization', () => {
  async function seedPayment(id: string, rideId: string): Promise<void> {
    const now = nowIso();
    await store().savePayment({
      id, rideId, type: 'ride', amount: 5, platformFeePercent: 10,
      platformFee: 0.5, driverEarnings: 4.5, status: 'created',
      createdAt: now, updatedAt: now,
    });
  }

  it('lets the ride passenger read their own payment', async () => {
    await seedUser({ uid: 'pay-pass', role: 'passenger' });
    await seedRide({ id: 'pay-ride', passengerId: 'pay-pass', driverId: 'pay-drv', status: 'completed' });
    await seedPayment('pay_own', 'pay-ride');
    const res = await request(app).get('/api/payments/pay_own').set(auth('pay-pass'));
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(5);
  });

  it('lets the ride driver read it too', async () => {
    await seedUser({ uid: 'pay-drv', role: 'driver' });
    const res = await request(app).get('/api/payments/pay_own').set(auth('pay-drv', 'driver'));
    expect(res.status).toBe(200);
  });

  it('refuses a stranger reading someone else’s payment record', async () => {
    await seedUser({ uid: 'pay-stranger', role: 'passenger' });
    const res = await request(app).get('/api/payments/pay_own').set(auth('pay-stranger'));
    expect(res.status).toBe(403);
  });

  it('refuses approve/complete/cancel when the payment’s ride cannot be resolved', async () => {
    await seedUser({ uid: 'pay-orphan', role: 'passenger' });
    await seedPayment('pay_orphan', 'ride-that-does-not-exist');
    const approve = await request(app)
      .post('/api/payments/pay_orphan/approve')
      .set(auth('pay-orphan'))
      .send({ piPaymentId: 'pi_x' });
    expect(approve.status).toBe(403);

    const complete = await request(app)
      .post('/api/payments/pay_orphan/complete')
      .set(auth('pay-orphan'))
      .send({ piPaymentId: 'pi_x', txid: 'tx_x' });
    expect(complete.status).toBe(403);

    const cancel = await request(app)
      .post('/api/payments/pay_orphan/cancel')
      .set(auth('pay-orphan'))
      .send({ piPaymentId: 'pi_x' });
    expect(cancel.status).toBe(403);
  });
});
