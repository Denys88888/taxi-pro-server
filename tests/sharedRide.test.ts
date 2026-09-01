import request from 'supertest';
import { createApp } from '../src/app';
import { store } from '../src/models';
import { signToken, signShareToken } from '../src/utils/jwt';
import { nowIso } from '../src/utils/helpers';
import type { Ride, RideStatus, User } from '../src/types';

// The share button minted a token, wrote it to the ride and put it in a URL —
// and nothing on either side ever read it back, so the link showed the
// recipient a login screen. This is the missing half.
//
// A share link is forwarded through chat apps and outlives the conversation, so
// the shape of what it exposes matters more than the fact it works at all.

const app = createApp();
const passengerAuth = { Authorization: `Bearer ${signToken({ uid: 'p_share', role: 'passenger' })}` };

let seq = 0;
async function seedRide(patch: Partial<Ride> = {}): Promise<Ride> {
  const now = nowIso();
  const ride = {
    id: `r_shared_${++seq}`,
    passengerId: 'p_share',
    driverId: 'd_share',
    pickup: { lat: 52.23, lng: 21.01, address: 'A' },
    destination: { lat: 52.2, lng: 21.05, address: 'B' },
    vehicleType: 'economy',
    distanceKm: 4.7,
    estimatedDurationMin: 8,
    fare: 4.14,
    platformFeePercent: 10,
    platformFee: 0.41,
    driverEarnings: 3.73,
    status: 'in_progress',
    createdAt: now,
    updatedAt: now,
    ...patch,
  } as Ride;
  await store().saveRide(ride);
  return ride;
}

async function seedDriver(): Promise<void> {
  const now = nowIso();
  await store().saveUser({
    uid: 'd_share',
    role: 'driver',
    name: 'Anna',
    phone: '+48111222333',
    rating: 4.9,
    ratingCount: 12,
    isBlocked: false,
    createdAt: now,
    updatedAt: now,
    driverInfo: {
      brand: 'Toyota',
      model: 'Corolla',
      color: 'white',
      number: 'WX 1234',
      vehicleType: 'economy',
      licenseVerified: true,
      applicationStatus: 'approved',
      isOnline: true,
      lastLocation: { lat: 52.22, lng: 21.02 },
    },
  } as User);
}

describe('following a shared ride link', () => {
  beforeEach(seedDriver);

  it('works with no account and no token of your own', async () => {
    const ride = await seedRide();
    const { body } = await request(app).post(`/api/rides/${ride.id}/share`).set(passengerAuth);

    const res = await request(app).get(`/api/rides/shared/${body.shareToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_progress');
    expect(res.body.driver.name).toBe('Anna');
    expect(res.body.driver.number).toBe('WX 1234');
    expect(res.body.driverLocation).toEqual({ lat: 52.22, lng: 21.02 });
  });

  // The list that matters. This link gets forwarded; it must not carry money or
  // anyone's phone number with it.
  it('carries no fare, no payment state and no phone numbers', async () => {
    const ride = await seedRide({ paymentStatus: 'held', txid: 'stellar_abc' });
    const { body } = await request(app).post(`/api/rides/${ride.id}/share`).set(passengerAuth);

    const res = await request(app).get(`/api/rides/shared/${body.shareToken}`);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('+48111222333');
    expect(serialised).not.toContain('stellar_abc');
    expect(res.body.fare).toBeUndefined();
    expect(res.body.paymentStatus).toBeUndefined();
    expect(res.body.driverEarnings).toBeUndefined();
    expect(res.body.passengerId).toBeUndefined();
    expect(res.body.driver.phone).toBeUndefined();
    expect(res.body.driver.uid).toBeUndefined();
  });

  // Otherwise the link keeps reporting that driver's whereabouts for the rest
  // of the token's life, long after the trip it was shared for.
  it.each<RideStatus>(['completed', 'cancelled'])(
    'stops reporting the driver position once the ride is %s',
    async (status) => {
      const ride = await seedRide();
      const { body } = await request(app).post(`/api/rides/${ride.id}/share`).set(passengerAuth);
      await store().updateRide(ride.id, { status });

      const res = await request(app).get(`/api/rides/shared/${body.shareToken}`);

      expect(res.status).toBe(200);
      expect(res.body.finished).toBe(true);
      expect(res.body.driverLocation).toBeNull();
    }
  );

  // Sharing again is the passenger's only way to revoke: the ride stores one
  // token, so the previous link has to go dead.
  it('kills the previous link when the ride is shared again', async () => {
    const ride = await seedRide();
    const first = (await request(app).post(`/api/rides/${ride.id}/share`).set(passengerAuth)).body
      .shareToken;
    const second = (await request(app).post(`/api/rides/${ride.id}/share`).set(passengerAuth)).body
      .shareToken;

    expect((await request(app).get(`/api/rides/shared/${second}`)).status).toBe(200);
    expect((await request(app).get(`/api/rides/shared/${first}`)).status).toBe(404);
  });

  it('refuses a token that was never issued', async () => {
    expect((await request(app).get('/api/rides/shared/not-a-token')).status).toBe(404);
  });

  // Correctly signed for a real ride, but never stored on it — a token minted
  // by anyone who got hold of the signing secret's output elsewhere must not
  // open a ride that was never shared.
  it('refuses a validly signed token the ride does not know about', async () => {
    const ride = await seedRide();
    const forged = signShareToken(ride.id);

    expect((await request(app).get(`/api/rides/shared/${forged}`)).status).toBe(404);
  });

  // A session token is signed with the same secret. It carries no rideId, so it
  // must not be usable here — and equally a share token must stay useless as a
  // session (verifyToken/verifyShareToken are deliberately separate).
  it('refuses a session token used as a share token', async () => {
    const session = signToken({ uid: 'p_share', role: 'passenger' });

    expect((await request(app).get(`/api/rides/shared/${session}`)).status).toBe(404);
  });
});
