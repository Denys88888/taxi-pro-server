import request from 'supertest';
import { createApp } from '../src/app';
import { store } from '../src/models';
import { signToken } from '../src/utils/jwt';
import type { Ride, User } from '../src/types';

// Accepting a ride used to be a fire-and-forget WebSocket frame. On a
// half-open connection — routine on a phone, and invisible, because readyState
// still reads OPEN — the driver's screen switched to the ride and they set off,
// while the server never heard and went on offering the same passenger to every
// other driver. Over HTTP the server answers, and the answer is the ride.

const app = createApp();

const asDriver = (uid: string): Record<string, string> => ({
  Authorization: `Bearer ${signToken({ uid, role: 'driver' })}`,
});
const asPassenger = (uid: string): Record<string, string> => ({
  Authorization: `Bearer ${signToken({ uid, role: 'passenger' })}`,
});

let seq = 0;

async function makeDriver(uid: string, over: Partial<User['driverInfo']> = {}): Promise<User> {
  const driver = {
    uid,
    role: 'driver',
    name: `Driver ${uid}`,
    rating: 5,
    ratingCount: 0,
    isBlocked: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    driverInfo: {
      vehicleType: 'economy',
      brand: 'Skoda',
      model: 'Octavia',
      color: 'White',
      number: 'WX 1',
      vehicleYear: 2020,
      isOnline: true,
      licenseVerified: true,
      applicationStatus: 'approved',
      ...over,
    },
  } as User;
  await store().saveUser(driver);
  return driver;
}

async function openRide(): Promise<Ride> {
  const now = new Date().toISOString();
  const ride = {
    id: `r_accept_${++seq}`,
    passengerId: `p_accept_${seq}`,
    pickup: { lat: 52.23, lng: 21.01 },
    destination: { lat: 52.2, lng: 21.05 },
    vehicleType: 'economy',
    distanceKm: 5,
    estimatedDurationMin: 10,
    fare: 10,
    platformFeePercent: 10,
    platformFee: 1,
    driverEarnings: 9,
    status: 'searching',
    createdAt: now,
    updatedAt: now,
  } as Ride;
  await store().saveRide(ride);
  return ride;
}

const accept = (rideId: string, headers: Record<string, string>) =>
  request(app).post(`/api/rides/${rideId}/accept`).set(headers).send({});

describe('POST /api/rides/:id/accept', () => {
  it('assigns the ride and answers with it plus the driver the passenger will see', async () => {
    const uid = 'd_ok';
    await makeDriver(uid);
    const ride = await openRide();

    const res = await accept(ride.id, asDriver(uid));

    expect(res.status).toBe(200);
    expect(res.body.ride.status).toBe('assigned');
    expect(res.body.ride.driverId).toBe(uid);
    // The card the passenger is shown — name and vehicle, never anything else
    // off the driver's record.
    expect(res.body.driverInfo.number).toBe('WX 1');
    expect((await store().getRide(ride.id))!.driverId).toBe(uid);
  });

  // The point of moving off the socket: a request that timed out has to be
  // safe to send again, and the driver must not be told the ride was taken by
  // themselves.
  it('lets the same driver re-send an accept that already succeeded', async () => {
    const uid = 'd_retry';
    await makeDriver(uid);
    const ride = await openRide();

    expect((await accept(ride.id, asDriver(uid))).status).toBe(200);
    const retry = await accept(ride.id, asDriver(uid));

    expect(retry.status).toBe(200);
    expect(retry.body.ride.driverId).toBe(uid);
  });

  it('tells the second driver the ride is gone, and does not move it', async () => {
    await makeDriver('d_first');
    await makeDriver('d_second');
    const ride = await openRide();

    expect((await accept(ride.id, asDriver('d_first'))).status).toBe(200);
    const second = await accept(ride.id, asDriver('d_second'));

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('TAKEN');
    expect((await store().getRide(ride.id))!.driverId).toBe('d_first');
  });

  // Two taps a few milliseconds apart is the case the lock exists for: without
  // it both read 'searching' and both write themselves in, and the loser drives
  // to a passenger who already has someone on the way.
  it('gives the ride to exactly one of two simultaneous accepts', async () => {
    await makeDriver('d_race_a');
    await makeDriver('d_race_b');
    const ride = await openRide();

    const [a, b] = await Promise.all([
      accept(ride.id, asDriver('d_race_a')),
      accept(ride.id, asDriver('d_race_b')),
    ]);

    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
    const winner = a.status === 200 ? 'd_race_a' : 'd_race_b';
    expect((await store().getRide(ride.id))!.driverId).toBe(winner);
  });

  it('refuses a driver who is off shift', async () => {
    await makeDriver('d_offline', { isOnline: false });
    const ride = await openRide();

    const res = await accept(ride.id, asDriver('d_offline'));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OFFLINE');
    expect((await store().getRide(ride.id))!.status).toBe('searching');
  });

  it('refuses a driver whose application is not approved', async () => {
    await makeDriver('d_pending', { applicationStatus: 'pending', licenseVerified: false });
    const ride = await openRide();

    expect((await accept(ride.id, asDriver('d_pending'))).body.code).toBe('NOT_VERIFIED');
  });

  it('refuses a blocked driver', async () => {
    const blocked = await makeDriver('d_blocked');
    await store().saveUser({ ...blocked, isBlocked: true });
    const ride = await openRide();

    expect((await accept(ride.id, asDriver('d_blocked'))).body.code).toBe('BLOCKED');
  });

  it('is closed to passengers', async () => {
    const ride = await openRide();

    expect((await accept(ride.id, asPassenger('p_nosy'))).status).toBe(403);
    expect((await store().getRide(ride.id))!.status).toBe('searching');
  });

  it('404s on a ride that does not exist', async () => {
    await makeDriver('d_404');
    expect((await accept('r_nope', asDriver('d_404'))).status).toBe(404);
  });
});
