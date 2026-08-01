import request from 'supertest';
import { createApp } from '../src/app';
import { timeBandSurge } from '../src/services/surgeService';
import { signToken } from '../src/utils/jwt';
import { store } from '../src/models';

// Surge used to be read off the clock at the moment the passenger tapped
// "order", which is the right clock for an immediate ride and the wrong one for
// a booking: the fare is frozen when the ride is created, so booking a 2 p.m.
// trip at 11 p.m. carried the ×2 night multiplier into the following afternoon
// and never let go. The bands are now evaluated at the time the ride runs.

const app = createApp();

// Warsaw: lng 21 → +1h from UTC under the 15°-per-hour approximation.
const WARSAW = { lat: 52.23, lng: 21.01 };
// A day with no fixed holiday on it in any timezone shift we apply.
const utc = (h: number, day = 15): Date => new Date(Date.UTC(2026, 6, day, h, 0, 0));

describe('surge bands follow the ride, not the booking', () => {
  it('prices the small hours as night wherever the passenger is', () => {
    // 02:00 UTC is 03:00 in Warsaw — night in both, so the band is unambiguous.
    expect(timeBandSurge(WARSAW, utc(2))).toEqual({ multiplier: 2, reason: 'night' });
  });

  it('prices the evening commute as peak', () => {
    // 17:00 UTC → 18:00 local, inside the 17–20 peak window.
    expect(timeBandSurge(WARSAW, utc(17))).toEqual({ multiplier: 1.3, reason: 'peak' });
  });

  it('charges nothing extra for an ordinary afternoon', () => {
    // 13:00 UTC → 14:00 local: no band at all.
    expect(timeBandSurge(WARSAW, utc(13))).toEqual({ multiplier: 1, reason: 'normal' });
  });

  it('gives a booking the band of its own hour, not the hour it was booked in', () => {
    const bookedAt = utc(22); // night, ×2 — when the passenger taps "book"
    const ridesAt = utc(13, 16); // ordinary afternoon the next day

    expect(timeBandSurge(WARSAW, bookedAt).multiplier).toBe(2);
    // The whole point: the ride is priced by when it runs.
    expect(timeBandSurge(WARSAW, ridesAt).multiplier).toBe(1);
  });

  it('shifts the band by longitude, so the same instant differs by city', () => {
    // 23:00 UTC is already night in Warsaw (00:00) but only 18:00 in New York
    // (lng -74 → -5h), which is the evening peak.
    expect(timeBandSurge(WARSAW, utc(23)).reason).toBe('night');
    expect(timeBandSurge({ lat: 40.71, lng: -74.0 }, utc(23)).reason).toBe('peak');
  });

  it('rolls the calendar with the timezone shift for holiday pricing', () => {
    // Fiji (lng 178 → +12h): 23:00 UTC on 24 December is 11:00 on Christmas
    // morning there. Late enough in the day to sit in no time band at all, so
    // ×2 can only come from the holiday — and reading the UTC calendar date
    // instead of the local one would have missed the holiday entirely.
    const FIJI = { lat: -18.14, lng: 178.44 };
    const xmasMorningLocal = new Date(Date.UTC(2026, 11, 24, 23, 0));

    expect(timeBandSurge(FIJI, xmasMorningLocal)).toEqual({ multiplier: 2, reason: 'holiday' });
  });
});

describe('GET /api/rides/surge', () => {
  const auth = { Authorization: `Bearer ${signToken({ uid: 'p_surge_q', role: 'passenger' })}` };

  it('accepts the time the ride is for', async () => {
    const at = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const res = await request(app).get('/api/rides/surge').query({ ...WARSAW, at }).set(auth);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('multiplier');
  });

  it('falls back to now rather than failing on a junk time', async () => {
    // A price preview is not worth a 400 — the passenger still needs a number.
    const res = await request(app).get('/api/rides/surge').query({ ...WARSAW, at: 'tomorrow-ish' }).set(auth);

    expect(res.status).toBe(200);
    expect(res.body.multiplier).toBe(1);
  });

  it('reports no surge at all when the admin has switched it off', async () => {
    await store().updateSettings({ surgeEnabled: false }, 'admin_test');
    const res = await request(app).get('/api/rides/surge').query(WARSAW).set(auth);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ multiplier: 1, reason: 'normal' });
    await store().updateSettings({ surgeEnabled: true }, 'admin_test');
  });
});
