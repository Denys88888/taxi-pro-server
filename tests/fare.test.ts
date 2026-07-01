import { calculateFare, estimateDurationMin } from '../src/services/fareCalculator';

describe('fareCalculator', () => {
  it('computes fare = (base + km*perKm + min*perMin) * surge', () => {
    const r = calculateFare({
      vehicleType: 'economy',
      distanceKm: 4.2,
      durationMin: 12,
      platformFeePercent: 10,
    });
    // economy: base 1 + 4.2*0.5 (2.1) + 12*0.1 (1.2) = 4.3
    expect(r.fare).toBeCloseTo(4.3, 2);
    expect(r.platformFee).toBeCloseTo(0.43, 2);
    expect(r.driverEarnings).toBeCloseTo(3.87, 2);
  });

  it('applies the surge multiplier', () => {
    const base = calculateFare({
      vehicleType: 'economy',
      distanceKm: 10,
      durationMin: 20,
      platformFeePercent: 10,
    });
    const surged = calculateFare({
      vehicleType: 'economy',
      distanceKm: 10,
      durationMin: 20,
      surge: 2,
      platformFeePercent: 10,
    });
    expect(surged.fare).toBeCloseTo(base.fare * 2, 1);
  });

  it('never charges below the vehicle minimum fare', () => {
    const r = calculateFare({
      vehicleType: 'business',
      distanceKm: 0.1,
      durationMin: 1,
      platformFeePercent: 10,
    });
    expect(r.fare).toBeGreaterThanOrEqual(3.5);
  });

  it('estimates duration from distance', () => {
    expect(estimateDurationMin(15)).toBe(30);
    expect(estimateDurationMin(0)).toBe(1);
  });
});
