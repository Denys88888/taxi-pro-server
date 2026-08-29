import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';

const app = createApp();
const auth = { Authorization: `Bearer ${signToken({ uid: 'call-user', role: 'passenger' })}` };

describe('GET /api/calls/turn-credentials', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/calls/turn-credentials')).status).toBe(401);
  });

  // No METERED_SECRET_KEY in the test environment (see tests/setup.ts) — this
  // pins the degrade-to-STUN-only behavior a driver/passenger actually hits
  // whenever Metered is unreachable, not just when it's unconfigured.
  it('degrades to an empty iceServers array rather than erroring, when TURN is not configured', async () => {
    const res = await request(app).get('/api/calls/turn-credentials').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ iceServers: [] });
  });
});
