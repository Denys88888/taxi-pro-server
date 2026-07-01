import request from 'supertest';
import { createApp } from '../src/app';
import { verifyToken } from '../src/utils/jwt';

// Mock the Pi API so we never hit the network in tests.
jest.mock('../src/services/piService', () => ({
  verifyPiAccessToken: jest.fn(),
}));
import { verifyPiAccessToken } from '../src/services/piService';

const app = createApp();

describe('POST /api/auth/pi', () => {
  it('rejects a missing accessToken (400)', async () => {
    const res = await request(app).post('/api/auth/pi').send({});
    expect(res.status).toBe(400);
  });

  it('rejects an invalid Pi token (401)', async () => {
    (verifyPiAccessToken as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(app).post('/api/auth/pi').send({ accessToken: 'bad' });
    expect(res.status).toBe(401);
  });

  it('issues a valid 24h JWT for a valid Pi token', async () => {
    (verifyPiAccessToken as jest.Mock).mockResolvedValueOnce({
      uid: 'pi-user-1',
      username: 'alice',
    });
    const res = await request(app).post('/api/auth/pi').send({ accessToken: 'good' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    const payload = verifyToken(res.body.token);
    expect(payload?.uid).toBe('pi-user-1');
    expect(payload?.role).toBe('passenger');
    expect(res.body.user.rating).toBe(5);
  });
});
