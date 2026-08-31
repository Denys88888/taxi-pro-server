import request from 'supertest';
import { createApp } from '../src/app';
import { store } from '../src/models';
import { signToken } from '../src/utils/jwt';
import type { Ride, RideStatus } from '../src/types';

const app = createApp();
const authFor = (uid: string, role: 'passenger' | 'driver' = 'passenger') => ({
  Authorization: `Bearer ${signToken({ uid, role })}`,
});

let seq = 0;
async function rideWith(status: RideStatus, passengerId: string, driverId?: string): Promise<Ride> {
  const now = new Date().toISOString();
  const ride = {
    id: `r_call_${++seq}`,
    passengerId,
    driverId,
    pickup: { lat: 52.23, lng: 21.01 },
    destination: { lat: 52.2, lng: 21.05 },
    vehicleType: 'economy',
    distanceKm: 4.7,
    estimatedDurationMin: 8,
    fare: 4.14,
    platformFeePercent: 10,
    platformFee: 0.41,
    driverEarnings: 3.73,
    status,
    createdAt: now,
    updatedAt: now,
  } as Ride;
  await store().saveRide(ride);
  return ride;
}

// A TURN credential is a working one-hour relay ticket billed against a 500 MB
// monthly quota that every real call shares. The endpoint originally handed one
// to anybody holding a token, with no ride involved at all — and while
// PI_SANDBOX is on, /api/auth/dev hands tokens to anyone who asks, so that was
// the open internet able to drain the quota real calls depend on. These pin the
// gate: you get a credential only for a ride you are actually on, and only
// while a call on it would make sense.
describe('GET /api/calls/turn-credentials', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/calls/turn-credentials?rideId=x')).status).toBe(401);
  });

  it('refuses a caller who names no ride', async () => {
    const res = await request(app).get('/api/calls/turn-credentials').set(authFor('p_noride'));
    expect(res.status).toBe(400);
  });

  it('refuses a ride that does not exist', async () => {
    const res = await request(app)
      .get('/api/calls/turn-credentials?rideId=r_does_not_exist')
      .set(authFor('p_ghost'));
    expect(res.status).toBe(403);
  });

  it("refuses someone who is not on the ride they asked about", async () => {
    const ride = await rideWith('in_progress', 'p_owner', 'd_owner');

    const res = await request(app)
      .get(`/api/calls/turn-credentials?rideId=${ride.id}`)
      .set(authFor('p_outsider'));

    expect(res.status).toBe(403);
  });

  // The other half of the gate: being on the ride is not enough once it is over,
  // or the two parties could keep reaching each other indefinitely afterwards.
  it.each<RideStatus>(['completed', 'cancelled', 'searching'])(
    'refuses a participant while the ride is %s',
    async (status) => {
      const ride = await rideWith(status, `p_${status}`, `d_${status}`);

      const res = await request(app)
        .get(`/api/calls/turn-credentials?rideId=${ride.id}`)
        .set(authFor(`p_${status}`));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RIDE_INACTIVE');
    }
  );

  // No METERED_SECRET_KEY in the test environment (see tests/setup.ts), so this
  // also pins the degrade-to-STUN-only path a real user hits whenever Metered
  // is unreachable — the gate passes, the relay simply isn't there.
  it.each<RideStatus>(['assigned', 'arrived', 'in_progress'])(
    'lets both parties through while the ride is %s',
    async (status) => {
      const ride = await rideWith(status, `p_ok_${status}`, `d_ok_${status}`);

      for (const [uid, role] of [
        [`p_ok_${status}`, 'passenger'],
        [`d_ok_${status}`, 'driver'],
      ] as const) {
        const res = await request(app)
          .get(`/api/calls/turn-credentials?rideId=${ride.id}`)
          .set(authFor(uid, role));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ iceServers: [] });
      }
    }
  );
});
