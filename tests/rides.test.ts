import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';

const app = createApp();
const token = signToken({ uid: 'passenger-1', role: 'passenger' });
const auth = { Authorization: `Bearer ${token}` };

const validRide = {
  pickup: { lat: 52.23, lng: 21.01, address: 'A' },
  destination: { lat: 52.2, lng: 21.05, address: 'B' },
  vehicleType: 'economy' as const,
};

describe('rides API', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/rides').send(validRide);
    expect(res.status).toBe(401);
  });

  it('rejects invalid payloads (400)', async () => {
    const res = await request(app)
      .post('/api/rides')
      .set(auth)
      .send({ pickup: { lat: 999, lng: 0 }, destination: validRide.destination, vehicleType: 'economy' });
    expect(res.status).toBe(400);
  });

  it('creates a ride with a server-computed fare', async () => {
    const res = await request(app).post('/api/rides').set(auth).send(validRide);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('searching');
    expect(res.body.fare).toBeGreaterThan(0);
    expect(res.body.platformFee).toBeGreaterThan(0);
    expect(res.body.driverEarnings).toBeCloseTo(res.body.fare - res.body.platformFee, 2);
  });

  it('lets the owner fetch, then cancel the ride', async () => {
    // Distinct passenger so the one-active-ride guard doesn't collide with other tests.
    const ownAuth = { Authorization: `Bearer ${signToken({ uid: 'passenger-fetch', role: 'passenger' })}` };
    const created = await request(app).post('/api/rides').set(ownAuth).send(validRide);
    const id = created.body.id;

    const got = await request(app).get(`/api/rides/${id}`).set(ownAuth);
    expect(got.status).toBe(200);

    const cancelled = await request(app)
      .post(`/api/rides/${id}/cancel`)
      .set(ownAuth)
      .send({ reason: 'changed my mind' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.cancellationFee).toBe(0); // free before driver arrives
  });

  it('forbids a stranger from viewing the ride (403)', async () => {
    const ownAuth = { Authorization: `Bearer ${signToken({ uid: 'passenger-owner', role: 'passenger' })}` };
    const created = await request(app).post('/api/rides').set(ownAuth).send(validRide);
    const strangerToken = signToken({ uid: 'someone-else', role: 'passenger' });
    const res = await request(app)
      .get(`/api/rides/${created.body.id}`)
      .set({ Authorization: `Bearer ${strangerToken}` });
    expect(res.status).toBe(403);
  });
});
