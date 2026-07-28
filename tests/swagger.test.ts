import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('GET /pinet/meta', () => {
  it('returns PiNetMetadataDTO with OG data', async () => {
    const res = await request(app).get('/pinet/meta');
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.title).toContain('Taxi Pro');
    expect(body.description).toBeTruthy();
    expect(body.openGraph?.images?.[0]?.url).toContain('og-image.png');
    expect(body.twitter?.card).toBe('summary_large_image');
  });

  it('does not require auth', async () => {
    const res = await request(app).get('/pinet/meta');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe('GET /api/docs', () => {
  it('serves Swagger UI HTML', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('swagger-ui');
  });

  it('serves spec JSON at /api/docs/spec.json', async () => {
    const res = await request(app).get('/api/docs/spec.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = JSON.parse(res.text);
    expect(body.openapi).toBe('3.0.3');
    expect(body.info.title).toBe('Taxi Pro API');
  });

  it('does not require auth', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
