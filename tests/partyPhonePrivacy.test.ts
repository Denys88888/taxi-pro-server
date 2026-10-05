import request from 'supertest';
import { createApp } from '../src/app';
import { store } from '../src/models';
import { signToken } from '../src/utils/jwt';
import { nowIso } from '../src/utils/helpers';
import type { Ride, User } from '../src/types';

// A ride puts two strangers in touch, and the app promises it does so without
// handing either one the other's phone number: calls go through the app. The
// screen kept that promise — it showed only the last four digits — while every
// ride response and the accept reply carried the full number underneath.

const app = createApp();
const PASSENGER_PHONE = '+48500111222';
const DRIVER_PHONE = '+48600333444';

const passengerAuth = { Authorization: `Bearer ${signToken({ uid: 'p_priv', role: 'passenger' })}` };
const driverAuth = { Authorization: `Bearer ${signToken({ uid: 'd_priv', role: 'driver' })}` };

async function seedPeople(): Promise<void> {
  const now = nowIso();
  await store().saveUser({
    uid: 'p_priv',
    role: 'passenger',
    name: 'Ola',
    phone: PASSENGER_PHONE,
    rating: 5,
    ratingCount: 3,
    isBlocked: false,
    createdAt: now,
    updatedAt: now,
  } as User);
  await store().saveUser({
    uid: 'd_priv',
    role: 'driver',
    name: 'Marek',
    phone: DRIVER_PHONE,
    rating: 4.8,
    ratingCount: 20,
    isBlocked: false,
    createdAt: now,
    updatedAt: now,
    driverInfo: {
      brand: 'Skoda',
      model: 'Octavia',
      color: 'grey',
      number: 'WA 5555',
      vehicleType: 'economy',
      licenseVerified: true,
      applicationStatus: 'approved',
      isOnline: true,
      lastLocation: { lat: 52.23, lng: 21.01 },
    },
  } as User);
}

let seq = 0;
async function seedRide(patch: Partial<Ride>): Promise<Ride> {
  const now = nowIso();
  const ride = {
    id: `r_priv_${++seq}`,
    passengerId: 'p_priv',
    pickup: { lat: 52.23, lng: 21.01, address: 'A' },
    destination: { lat: 52.2, lng: 21.05, address: 'B' },
    vehicleType: 'economy',
    distanceKm: 4.7,
    estimatedDurationMin: 8,
    fare: 4.14,
    platformFeePercent: 10,
    platformFee: 0.41,
    driverEarnings: 3.73,
    status: 'searching',
    createdAt: now,
    updatedAt: now,
    ...patch,
  } as Ride;
  await store().saveRide(ride);
  return ride;
}

describe('the other side of a ride never gets your phone number', () => {
  beforeEach(seedPeople);

  it('is left out of the driver card the passenger sees', async () => {
    const ride = await seedRide({ status: 'assigned', driverId: 'd_priv' });

    const res = await request(app).get(`/api/rides/${ride.id}`).set(passengerAuth);

    expect(res.status).toBe(200);
    expect(res.body.driver.name).toBe('Marek');
    expect(JSON.stringify(res.body)).not.toContain(DRIVER_PHONE);
  });

  it('is left out of the passenger card the driver sees', async () => {
    const ride = await seedRide({ status: 'in_progress', driverId: 'd_priv' });

    const res = await request(app).get(`/api/rides/${ride.id}`).set(driverAuth);

    expect(res.status).toBe(200);
    expect(res.body.passenger.name).toBe('Ola');
    expect(JSON.stringify(res.body)).not.toContain(PASSENGER_PHONE);
  });

  it('is left out of the driver card handed back when a ride is accepted', async () => {
    const ride = await seedRide({ status: 'searching' });

    const res = await request(app).post(`/api/rides/${ride.id}/accept`).set(driverAuth);

    expect(res.status).toBe(200);
    expect(res.body.driverInfo.name).toBe('Marek');
    expect(JSON.stringify(res.body)).not.toContain(DRIVER_PHONE);
  });
});
