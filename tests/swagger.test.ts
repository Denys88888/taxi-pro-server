import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('GET /api/docs', () => {
  it('serves Swagger UI HTML', async () => {
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('swagger');
  });

  it('does not require auth', async () => {
    const res = await request(app).get('/api/docs/');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
