import { haversineKm } from '../src/utils/helpers';

describe('haversineKm', () => {
  it('is zero for identical points', () => {
    expect(haversineKm(52.2297, 21.0122, 52.2297, 21.0122)).toBeCloseTo(0, 5);
  });

  it('matches a known distance within 1% (Warsaw → Kraków ≈ 252 km)', () => {
    const d = haversineKm(52.2297, 21.0122, 50.0647, 19.945);
    expect(d).toBeGreaterThan(249);
    expect(d).toBeLessThan(255);
  });
});
