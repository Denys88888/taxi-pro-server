import request from 'supertest';
import { createApp } from '../src/app';
import { store } from '../src/models';
import { startScheduler } from '../src/services/scheduler';
import { signToken } from '../src/utils/jwt';
import { MAX_PENDING_SCHEDULED_RIDES, SCHEDULED_DISPATCH_GRACE_MS } from '../src/config/constants';
import type { Ride, RideStatus } from '../src/types';

// Booking a ride for later used to count as "already riding": the create-ride
// gate refused any new order while a 'scheduled' ride existed, so a passenger
// who booked a trip for tomorrow could not order a taxi today at all. A booking
// is now a promise about the future, not a ride in progress — but it still has
// to be bounded (a cap, and no two bookings on top of each other), and the
// dispatcher must not send one out while its passenger is mid-trip.

const app = createApp();
const MIN = 60 * 1000;

const authFor = (uid: string): Record<string, string> => ({
  Authorization: `Bearer ${signToken({ uid, role: 'passenger' })}`,
});

const inMin = (m: number): string => new Date(Date.now() + m * MIN).toISOString();

function order(uid: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/rides')
    .set(authFor(uid))
    .send({
      pickup: { lat: 52.23, lng: 21.01, address: 'A' },
      destination: { lat: 52.2, lng: 21.05, address: 'B' },
      vehicleType: 'economy',
      ...body,
    });
}

function mkRide(id: string, patch: Partial<Ride>): Ride {
  const now = new Date().toISOString();
  return {
    id,
    passengerId: `p_${id}`,
    pickup: { lat: 52.23, lng: 21.01 },
    destination: { lat: 52.2, lng: 21.05 },
    vehicleType: 'economy',
    distanceKm: 5,
    estimatedDurationMin: 10,
    fare: 4,
    platformFeePercent: 10,
    platformFee: 0.4,
    driverEarnings: 3.6,
    paymentStatus: 'pending',
    status: 'searching',
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

// The tick isn't exported; drive it through the public entry point.
async function runTicks(ms = 250): Promise<void> {
  const handle = startScheduler(25);
  await new Promise((r) => setTimeout(r, ms));
  clearInterval(handle);
}

async function statusOf(id: string): Promise<RideStatus | undefined> {
  return (await store().getRide(id))?.status;
}

describe('a booking does not block ordering', () => {
  it('lets a passenger order right now while a ride is booked for tomorrow', async () => {
    const uid = 'p_book_then_order';
    const booked = await order(uid, { scheduledAt: inMin(24 * 60) });
    expect(booked.status).toBe(201);
    expect(booked.body.status).toBe('scheduled');

    // The whole point of the fix: this used to be 409 ACTIVE_RIDE_EXISTS.
    const now = await order(uid);
    expect(now.status).toBe(201);
    expect(now.body.status).toBe('searching');
  });

  it('still refuses a second order while a ride is under way', async () => {
    const uid = 'p_double_live';
    expect((await order(uid)).status).toBe(201);

    const second = await order(uid);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ACTIVE_RIDE_EXISTS');
  });

  it('refuses a booking too while a ride is under way', async () => {
    // A live ride blocks everything, including booking ahead — the passenger
    // is in a car right now and the ride screen is the place to be.
    const uid = 'p_live_then_book';
    expect((await order(uid)).status).toBe(201);

    const later = await order(uid, { scheduledAt: inMin(24 * 60) });
    expect(later.status).toBe(409);
    expect(later.body.code).toBe('ACTIVE_RIDE_EXISTS');
  });
});

describe('bookings are bounded', () => {
  it(`caps pending bookings at ${MAX_PENDING_SCHEDULED_RIDES}`, async () => {
    const uid = 'p_cap';
    // Spaced well past the minimum gap so only the cap can be what stops it.
    for (let i = 1; i <= MAX_PENDING_SCHEDULED_RIDES; i++) {
      const res = await order(uid, { scheduledAt: inMin(i * 120) });
      expect(res.status).toBe(201);
    }

    const overflow = await order(uid, { scheduledAt: inMin((MAX_PENDING_SCHEDULED_RIDES + 1) * 120) });
    expect(overflow.status).toBe(409);
    expect(overflow.body.code).toBe('TOO_MANY_SCHEDULED');
  });

  it('refuses a second booking that lands on top of the first', async () => {
    const uid = 'p_clash';
    expect((await order(uid, { scheduledAt: inMin(180) })).status).toBe(201);

    // 10 minutes apart — inside the 30-minute gap.
    const clash = await order(uid, { scheduledAt: inMin(190) });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SCHEDULED_CONFLICT');
  });

  it('allows a second booking that is far enough away', async () => {
    const uid = 'p_no_clash';
    expect((await order(uid, { scheduledAt: inMin(180) })).status).toBe(201);

    const ok = await order(uid, { scheduledAt: inMin(240) });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('scheduled');
  });

  it('does not count another passenger\'s bookings against the cap', async () => {
    for (let i = 1; i <= MAX_PENDING_SCHEDULED_RIDES; i++) {
      expect((await order('p_neighbour', { scheduledAt: inMin(i * 120) })).status).toBe(201);
    }

    const mine = await order('p_bystander', { scheduledAt: inMin(120) });
    expect(mine.status).toBe(201);
  });
});

describe('the dispatcher waits for a free slot', () => {
  it('does not send out a due booking while the passenger is riding', async () => {
    const uid = 'p_busy_at_pickup';
    await store().saveRide(mkRide('ride_busy_live', { passengerId: uid, status: 'in_progress' }));
    await store().saveRide(
      mkRide('ride_busy_booking', {
        passengerId: uid,
        status: 'scheduled',
        scheduledAt: new Date(Date.now() - 1000).toISOString(),
      })
    );

    await runTicks();

    // Two live rides at once would put two drivers on one passenger.
    expect(await statusOf('ride_busy_booking')).toBe('scheduled');
    expect(await statusOf('ride_busy_live')).toBe('in_progress');
  });

  it('sends it out on the first tick after the passenger is free', async () => {
    const uid = 'p_frees_up';
    await store().saveRide(mkRide('ride_free_live', { passengerId: uid, status: 'in_progress' }));
    await store().saveRide(
      mkRide('ride_free_booking', {
        passengerId: uid,
        status: 'scheduled',
        scheduledAt: new Date(Date.now() - 1000).toISOString(),
      })
    );

    await runTicks();
    expect(await statusOf('ride_free_booking')).toBe('scheduled');

    await store().updateRide('ride_free_live', { status: 'completed' });
    await runTicks();

    expect(await statusOf('ride_free_booking')).toBe('searching');
  });

  it('drops a booking whose passenger never freed up in time', async () => {
    const uid = 'p_never_free';
    await store().saveRide(mkRide('ride_never_live', { passengerId: uid, status: 'in_progress' }));
    await store().saveRide(
      mkRide('ride_never_booking', {
        passengerId: uid,
        status: 'scheduled',
        scheduledAt: new Date(Date.now() - SCHEDULED_DISPATCH_GRACE_MS - MIN).toISOString(),
      })
    );

    await runTicks();

    // Sending a car an hour late is worse than not sending one.
    expect(await statusOf('ride_never_booking')).toBe('cancelled');
  });
});
