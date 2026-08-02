import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';
import { store } from '../src/models';
import { nowIso, genId } from '../src/utils/helpers';
import type { User, Ride } from '../src/types';

// A late cancellation charges the passenger a fee, pays the driver a share of
// it and leaves the rest with the platform. Every dashboard figure was computed
// from completed rides alone, so that money existed in the wallet and in no
// report: revenue was understated and the driver who was paid it did not get
// credited for it. These cover the three places that read it.

const app = createApp();
const adminAuth = {
  Authorization: `Bearer ${signToken({ uid: 'admin_analytics', role: 'admin' })}`,
};

const DRIVER = 'drv_analytics';

async function seedDriver(): Promise<void> {
  await store().saveUser({
    uid: DRIVER,
    role: 'driver',
    name: 'Analytics Driver',
    rating: 5,
    ratingCount: 0,
    isBlocked: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as User);
}

async function seedRide(overrides: Partial<Ride>): Promise<Ride> {
  const ride = {
    id: genId('ride'),
    passengerId: 'pax_analytics',
    driverId: DRIVER,
    pickup: { lat: 52.23, lng: 21.01, address: 'Centrum, Warszawa' },
    destination: { lat: 52.2, lng: 21.05, address: 'Praga, Warszawa' },
    vehicleType: 'economy',
    distanceKm: 5,
    estimatedDurationMin: 10,
    platformFeePercent: 10,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  } as Ride;
  await store().saveRide(ride);
  return ride;
}

// 1 pi to the platform, 9 to the driver.
const COMPLETED: Partial<Ride> = {
  status: 'completed',
  paymentStatus: 'completed',
  fare: 10,
  platformFee: 1,
  driverEarnings: 9,
};

// Fee of 4 collected, 3.6 of it to the driver: 0.4 is platform revenue.
const FEE_PAID: Partial<Ride> = {
  status: 'cancelled',
  paymentStatus: 'cancelled',
  fare: 10,
  platformFee: 1,
  driverEarnings: 9,
  cancelledBy: 'passenger',
  cancellationFee: 4,
  cancellationFeeStatus: 'paid',
  cancellationFeeDriverEarnings: 3.6,
};

beforeAll(async () => {
  await seedDriver();
  await seedRide(COMPLETED);
  await seedRide(FEE_PAID);
  // Raised but never paid: nothing has moved, so it is not revenue yet.
  await seedRide({ ...FEE_PAID, cancellationFeeStatus: 'outstanding' });
});

describe('cancellation-fee revenue reaches the dashboard', () => {
  it('counts the platform share of a collected fee in stats', async () => {
    const res = await request(app).get('/api/admin/stats').set(adminAuth);
    expect(res.status).toBe(200);
    // 1 from the completed ride + 0.4 kept from the collected fee. The
    // outstanding fee contributes nothing.
    expect(res.body.platformEarnings).toBeCloseTo(1.4, 6);
    // A cancelled ride is still not a completed one.
    expect(res.body.completedRides).toBe(1);
    expect(res.body.totalRides).toBe(3);
  });

  it('counts fee revenue in revenueByDay without calling it a ride', async () => {
    const res = await request(app).get('/api/admin/analytics').set(adminAuth);
    expect(res.status).toBe(200);
    const today = res.body.revenueByDay.at(-1);
    expect(today.date).toBe(new Date().toISOString().slice(0, 10));
    expect(today.revenue).toBeCloseTo(1.4, 6);
    expect(today.rides).toBe(1);
  });

  it('credits the driver with the fee they were paid, as earnings not rides', async () => {
    const res = await request(app).get('/api/admin/analytics').set(adminAuth);
    const driver = res.body.topDrivers.find((d: { uid: string }) => d.uid === DRIVER);
    expect(driver).toBeDefined();
    // 9 from the trip they drove + 3.6 from the trip that was cancelled on them.
    expect(driver.earnings).toBeCloseTo(12.6, 6);
    expect(driver.rides).toBe(1);
    expect(driver.name).toBe('Analytics Driver');
  });

  it('does not treat a cancelled ride as a route anyone travelled', async () => {
    const res = await request(app).get('/api/admin/analytics').set(adminAuth);
    const route = res.body.topRoutes.find((r: { route: string }) =>
      r.route.startsWith('Centrum')
    );
    expect(route.count).toBe(1);
  });
});
