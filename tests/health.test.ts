import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('GET /api/health', () => {
  afterEach(() => {
    delete process.env.RENDER_GIT_COMMIT;
  });

  it('returns 200 with sandbox + storage mode', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('sandbox');
    expect(res.body).toHaveProperty('firebase');
  });

  // The only way to tell from outside whether a push reached the running
  // service: a deploy that failed to build leaves the old instance answering
  // 200, so 'ok' alone proves nothing about which code is live.
  it('reports the deployed commit when the platform provides one', async () => {
    process.env.RENDER_GIT_COMMIT = '7cf52cd0123456789abcdef';
    const res = await request(app).get('/api/health');
    expect(res.body.commit).toBe('7cf52cd');
  });

  it('omits the commit rather than guessing where the variable is unset', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body).not.toHaveProperty('commit');
  });
});
