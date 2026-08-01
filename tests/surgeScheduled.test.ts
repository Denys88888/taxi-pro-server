import request from 'supertest';
import { signToken } from '../src/utils/jwt';
import { getSurge } from '../src/services/surgeService';

// The bands themselves are covered in surgeBands.test.ts. What matters here is
// the wiring: that createRide asks for the surge of the moment the ride will
// actually run. Surge is stamped onto the ride once and never recomputed, so
// asking with the wrong instant overcharges (or undercharges) the passenger
// permanently — and NODE_ENV=test flattens the real multiplier to 1, which
// would hide the mistake from every other test in the suite.
jest.mock('../src/services/surgeService', () => ({
  getSurge: jest.fn(async () => ({ multiplier: 1, reason: 'normal' })),
}));

const mockedGetSurge = getSurge as jest.MockedFunction<typeof getSurge>;

// Imported after the mock is registered so the controller picks it up.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app') as typeof import('../src/app');
const app = createApp();

const auth = (uid: string): Record<string, string> => ({
  Authorization: `Bearer ${signToken({ uid, role: 'passenger' })}`,
});

const body = (extra: Record<string, unknown> = {}) => ({
  pickup: { lat: 52.23, lng: 21.01, address: 'A' },
  destination: { lat: 52.2, lng: 21.05, address: 'B' },
  vehicleType: 'economy',
  ...extra,
});

beforeEach(() => {
  mockedGetSurge.mockClear();
});

describe('createRide prices a ride by the clock it runs on', () => {
  it('asks for the surge of the booked time, not of right now', async () => {
    const when = new Date(Date.now() + 14 * 60 * 60 * 1000);

    const res = await request(app)
      .post('/api/rides')
      .set(auth('p_surge_sched'))
      .send(body({ scheduledAt: when.toISOString() }));

    expect(res.status).toBe(201);
    expect(mockedGetSurge).toHaveBeenCalledTimes(1);
    const [, at] = mockedGetSurge.mock.calls[0];
    expect(at).toBeInstanceOf(Date);
    expect((at as Date).getTime()).toBe(when.getTime());
  });

  it('leaves an immediate order on the current clock', async () => {
    const res = await request(app).post('/api/rides').set(auth('p_surge_now')).send(body());

    expect(res.status).toBe(201);
    const [, at] = mockedGetSurge.mock.calls[0];
    expect(at).toBeUndefined();
  });

  it('treats a scheduledAt already in the past as an order for right now', async () => {
    // The ride starts searching immediately, so "now" is the correct clock —
    // passing the stale timestamp through would price a fresh ride off it.
    const res = await request(app)
      .post('/api/rides')
      .set(auth('p_surge_past'))
      .send(body({ scheduledAt: new Date(Date.now() - 60_000).toISOString() }));

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('searching');
    const [, at] = mockedGetSurge.mock.calls[0];
    expect(at).toBeUndefined();
  });
});
