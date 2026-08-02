import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';
import { store } from '../src/models';
import { nowIso } from '../src/utils/helpers';
import type { User } from '../src/types';

// Who pays when a trip is called off. The fee is compensation for wasting the
// driver's time, so it is the passenger's to pay and nobody else's — and the
// record of who walked away has to name the side of *this* ride they were on,
// not whichever mode their app happened to be in at the time.

const app = createApp();

function authFor(uid: string, role: 'passenger' | 'driver' = 'passenger') {
  return { Authorization: `Bearer ${signToken({ uid, role })}` };
}

async function seedUser(uid: string, role: User['role']): Promise<void> {
  await store().saveUser({
    uid,
    role,
    name: uid,
    rating: 5,
    ratingCount: 0,
    isBlocked: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as User);
}

const pickup = { lat: 52.23, lng: 21.01, address: 'A' };
const destination = { lat: 52.2, lng: 21.05, address: 'B' };

// Creates a ride for `passengerUid` and moves it to `status` with a driver on it.
async function rideInProgress(
  passengerUid: string,
  driverUid: string,
  status: 'assigned' | 'arrived' | 'in_progress',
  extra: Record<string, unknown> = {}
): Promise<{ id: string; fare: number }> {
  await seedUser(passengerUid, 'passenger');
  await seedUser(driverUid, 'driver');
  const created = await request(app)
    .post('/api/rides')
    .set(authFor(passengerUid))
    .send({ pickup, destination, vehicleType: 'economy' });
  expect(created.status).toBe(201);
  await store().updateRide(created.body.id, { status, driverId: driverUid, ...extra });
  return { id: created.body.id, fare: created.body.fare };
}

describe('cancellation fee follows who cancelled', () => {
  it('charges the passenger half the fare for calling off a trip under way', async () => {
    const { id, fare } = await rideInProgress('cx-pass-1', 'cx-drv-1', 'in_progress');
    const res = await request(app)
      .post(`/api/rides/${id}/cancel`)
      .set(authFor('cx-pass-1'))
      .send({ reason: 'late-cancel' });
    expect(res.status).toBe(200);
    expect(res.body.cancellationFee).toBeCloseTo(fare / 2, 2);
    expect(res.body.cancelledBy).toBe('passenger');
  });

  it('charges the passenger nothing when the driver abandons the trip', async () => {
    const { id } = await rideInProgress('cx-pass-2', 'cx-drv-2', 'in_progress');
    const res = await request(app)
      .post(`/api/rides/${id}/cancel`)
      .set(authFor('cx-drv-2', 'driver'))
      .send({ reason: 'car trouble' });
    expect(res.status).toBe(200);
    expect(res.body.cancellationFee).toBe(0);
    expect(res.body.cancelledBy).toBe('driver');
  });

  it('charges the passenger nothing when the driver gives up after arriving', async () => {
    // Arrived ten minutes ago — well past the free window, which would bill the
    // passenger if the fee ignored who is cancelling.
    const arrivedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { id } = await rideInProgress('cx-pass-3', 'cx-drv-3', 'arrived', { arrivedAt });
    const res = await request(app)
      .post(`/api/rides/${id}/cancel`)
      .set(authFor('cx-drv-3', 'driver'))
      .send({ reason: 'rider never came out' });
    expect(res.status).toBe(200);
    expect(res.body.cancellationFee).toBe(0);
  });

  it('still bills the passenger who keeps the driver waiting past the grace window', async () => {
    const arrivedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { id, fare } = await rideInProgress('cx-pass-4', 'cx-drv-4', 'arrived', { arrivedAt });
    const res = await request(app)
      .post(`/api/rides/${id}/cancel`)
      .set(authFor('cx-pass-4'))
      .send({ reason: 'late-cancel' });
    expect(res.status).toBe(200);
    expect(res.body.cancellationFee).toBeCloseTo(fare / 2, 2);
  });

  it('leaves the passenger free inside the grace window after arrival', async () => {
    const arrivedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const { id } = await rideInProgress('cx-pass-5', 'cx-drv-5', 'arrived', { arrivedAt });
    const res = await request(app)
      .post(`/api/rides/${id}/cancel`)
      .set(authFor('cx-pass-5'))
      .send({ reason: 'user-cancel' });
    expect(res.status).toBe(200);
    expect(res.body.cancellationFee).toBe(0);
  });

  it('charges nothing on an arrived ride that never recorded an arrival time', async () => {
    // The status and the timestamp are written together, so this only happens
    // if we lost the stamp. The passenger does not pay for our bookkeeping.
    const { id } = await rideInProgress('cx-pass-6', 'cx-drv-8', 'arrived');
    const res = await request(app)
      .post(`/api/rides/${id}/cancel`)
      .set(authFor('cx-pass-6'))
      .send({ reason: 'user-cancel' });
    expect(res.status).toBe(200);
    expect(res.body.cancellationFee).toBe(0);
  });
});

describe('cancelledBy names the side of the ride, not the app mode', () => {
  it('records a passenger who is in driver mode as the passenger', async () => {
    // A driver who also takes rides: they booked this one as a passenger, then
    // switched the app to driver mode before calling it off. The token says
    // 'driver'; on this ride they are the passenger.
    const { id } = await rideInProgress('cx-both', 'cx-drv-6', 'assigned');
    const res = await request(app)
      .post(`/api/rides/${id}/cancel`)
      .set(authFor('cx-both', 'driver'))
      .send({ reason: 'changed my mind' });
    expect(res.status).toBe(200);
    expect(res.body.cancelledBy).toBe('passenger');
  });

  it('records the driver as the driver even in passenger mode', async () => {
    const arrivedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { id } = await rideInProgress('cx-pass-7', 'cx-drv-7', 'arrived', { arrivedAt });
    const res = await request(app)
      .post(`/api/rides/${id}/cancel`)
      .set(authFor('cx-drv-7', 'passenger'))
      .send({ reason: 'cannot reach the pickup' });
    expect(res.status).toBe(200);
    expect(res.body.cancelledBy).toBe('driver');
    expect(res.body.cancellationFee).toBe(0);
  });
});
