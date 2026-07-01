import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';

const app = createApp();
const adminAuth = { Authorization: `Bearer ${signToken({ uid: 'admin-1', role: 'admin' })}` };
const passengerAuth = {
  Authorization: `Bearer ${signToken({ uid: 'pass-9', role: 'passenger' })}`,
};

describe('admin RBAC', () => {
  it('denies unauthenticated access (401)', async () => {
    const res = await request(app).get('/api/admin/stats');
    expect(res.status).toBe(401);
  });

  it('denies non-admins (403)', async () => {
    const res = await request(app).get('/api/admin/stats').set(passengerAuth);
    expect(res.status).toBe(403);
  });

  it('allows admins to read stats', async () => {
    const res = await request(app).get('/api/admin/stats').set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalRides');
    expect(res.body).toHaveProperty('platformEarnings');
  });

  it('constrains platform fee to 0–20% (400 out of range)', async () => {
    const bad = await request(app)
      .patch('/api/admin/settings')
      .set(adminAuth)
      .send({ platformFeePercent: 50 });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .patch('/api/admin/settings')
      .set(adminAuth)
      .send({ platformFeePercent: 15 });
    expect(ok.status).toBe(200);
    expect(ok.body.platformFeePercent).toBe(15);
  });
});
