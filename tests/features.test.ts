import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';
import { store } from '../src/models';
import { nowIso } from '../src/utils/helpers';
import type { User } from '../src/types';

const app = createApp();

function authFor(uid: string, role: 'passenger' | 'driver' = 'passenger') {
  return { Authorization: `Bearer ${signToken({ uid, role })}` };
}

async function seedUser(u: Partial<User> & { uid: string; role: User['role'] }): Promise<void> {
  await store().saveUser({
    name: u.uid,
    rating: 5,
    ratingCount: 0,
    isBlocked: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...u,
  } as User);
}

const pickup = { lat: 52.23, lng: 21.01, address: 'A' };
const destination = { lat: 52.2, lng: 21.05, address: 'B' };

describe('profile update (phone + avatar)', () => {
  it('updates phone and avatar via PATCH /api/users/me', async () => {
    await seedUser({ uid: 'p-prof', role: 'passenger' });
    const res = await request(app)
      .patch('/api/users/me')
      .set(authFor('p-prof'))
      .send({ phone: '+15551234567', avatar: 'data:image/png;base64,AAAA' });
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('+15551234567');
    expect(res.body.avatar).toContain('data:image');
  });
});

describe('multi-stop rides', () => {
  it('includes stops and prices the full path', async () => {
    const direct = await request(app)
      .post('/api/rides')
      .set(authFor('p-ms'))
      .send({ pickup, destination, vehicleType: 'economy' });
    const withStop = await request(app)
      .post('/api/rides')
      .set(authFor('p-ms'))
      .send({
        pickup,
        destination,
        vehicleType: 'economy',
        stops: [{ lat: 52.25, lng: 21.1 }],
      });
    expect(withStop.status).toBe(201);
    expect(withStop.body.stops).toHaveLength(1);
    // A detour via a stop is longer, so the fare must be >= the direct fare.
    expect(withStop.body.distanceKm).toBeGreaterThan(direct.body.distanceKm);
    expect(withStop.body.fare).toBeGreaterThanOrEqual(direct.body.fare);
  });
});

describe('scheduled rides', () => {
  it('creates a future ride as scheduled (not broadcast)', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const res = await request(app)
      .post('/api/rides')
      .set(authFor('p-sched'))
      .send({ pickup, destination, vehicleType: 'economy', scheduledAt: future });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('scheduled');
    expect(res.body.scheduledAt).toBe(future);
  });
});

describe('fare negotiation (inDriver)', () => {
  it('lets a driver offer and a passenger accept', async () => {
    await seedUser({ uid: 'nd-driver', role: 'driver', name: 'Dana' });
    const created = await request(app)
      .post('/api/rides')
      .set(authFor('nd-pass'))
      .send({ pickup, destination, vehicleType: 'economy', negotiable: true, offeredFare: 5 });
    expect(created.body.negotiable).toBe(true);
    const rideId = created.body.id;

    const offer = await request(app)
      .post(`/api/rides/${rideId}/offers`)
      .set(authFor('nd-driver', 'driver'))
      .send({ amount: 6, etaMin: 4 });
    expect(offer.status).toBe(201);
    expect(offer.body.offers).toHaveLength(1);

    const accept = await request(app)
      .post(`/api/rides/${rideId}/offers/accept`)
      .set(authFor('nd-pass'))
      .send({ driverId: 'nd-driver' });
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe('assigned');
    expect(accept.body.driverId).toBe('nd-driver');
    expect(accept.body.fare).toBe(6);
  });
});

describe('phone visibility on assigned ride', () => {
  it('exposes the driver contact card once assigned', async () => {
    await seedUser({ uid: 'pv-driver', role: 'driver', name: 'Drew', phone: '+15559990000' });
    await seedUser({ uid: 'pv-pass', role: 'passenger', phone: '+15551110000' });
    const created = await request(app)
      .post('/api/rides')
      .set(authFor('pv-pass'))
      .send({ pickup, destination, vehicleType: 'economy' });
    const rideId = created.body.id;
    // Before assignment: no driver party.
    const before = await request(app).get(`/api/rides/${rideId}`).set(authFor('pv-pass'));
    expect(before.body.driver).toBeNull();
    // Assign, then the passenger should see the driver's phone.
    await store().updateRide(rideId, { status: 'assigned', driverId: 'pv-driver' });
    const after = await request(app).get(`/api/rides/${rideId}`).set(authFor('pv-pass'));
    expect(after.body.driver?.phone).toBe('+15559990000');
  });
});

describe('reports (complaints)', () => {
  it('lets a ride participant file a report; a stranger cannot', async () => {
    const created = await request(app)
      .post('/api/rides')
      .set(authFor('rp-pass'))
      .send({ pickup, destination, vehicleType: 'economy' });
    const rideId = created.body.id;

    const ok = await request(app)
      .post('/api/reports')
      .set(authFor('rp-pass'))
      .send({ rideId, reportedId: 'someone', reason: 'rude', description: 'test' });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('open');

    const stranger = await request(app)
      .post('/api/reports')
      .set(authFor('rp-stranger'))
      .send({ rideId, reportedId: 'x', reason: 'x' });
    expect(stranger.status).toBe(403);

    // Admin sees and resolves it.
    const list = await request(app)
      .get('/api/admin/reports?status=open')
      .set({ Authorization: `Bearer ${signToken({ uid: 'rp-admin', role: 'admin' })}` });
    expect(list.body.reports.some((r: { id: string }) => r.id === ok.body.id)).toBe(true);
  });
});
