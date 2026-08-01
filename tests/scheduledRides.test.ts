import request from 'supertest';
import { createApp } from '../src/app';
import { store } from '../src/models';
import { startScheduler } from '../src/services/scheduler';
import { signToken } from '../src/utils/jwt';
import type { Ride, RideStatus } from '../src/types';

// A ride booked in advance sits as 'scheduled' until the dispatcher promotes it
// to 'searching'. The scheduler then ages every searching ride to decide when to
// widen the radius and when to give up. That age used to be measured from
// createdAt — which for a scheduled ride is when the passenger *booked* it, not
// when drivers started being offered it. A ride booked more than the 15-minute
// search timeout in advance was therefore already "expired" the moment it went
// out, and the very next tick auto-cancelled it before any driver could accept.
// searchStartedAt is the field of record for that now.

const app = createApp();
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const MIN = 60 * 1000;

function mkRide(id: string, patch: Partial<Ride>): Ride {
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
    createdAt: iso(0),
    updatedAt: iso(0),
    ...patch,
  };
}

// Run the scheduler for a few real ticks. The tick isn't exported, so drive it
// through the public entry point at a short interval; several ticks is the
// point, since the regression only showed up on the tick *after* promotion.
async function runTicks(ms = 250): Promise<void> {
  const handle = startScheduler(25);
  await new Promise((r) => setTimeout(r, ms));
  clearInterval(handle);
}

async function statusOf(id: string): Promise<RideStatus | undefined> {
  return (await store().getRide(id))?.status;
}

describe('scheduled ride dispatch', () => {
  it('promotes a ride booked hours ago and leaves it searching', async () => {
    // Booked 3 hours ago for a pickup time that has just arrived.
    await store().saveRide(
      mkRide('ride_sched_old', {
        status: 'scheduled',
        createdAt: iso(180 * MIN),
        updatedAt: iso(180 * MIN),
        scheduledAt: iso(1000),
      })
    );

    await runTicks();

    // Before the fix this was 'cancelled': promoted on one tick, then aged from
    // createdAt (3h) and auto-cancelled on the next.
    expect(await statusOf('ride_sched_old')).toBe('searching');
  });

  it('stamps searchStartedAt when it promotes the ride', async () => {
    await store().saveRide(
      mkRide('ride_sched_stamp', {
        status: 'scheduled',
        createdAt: iso(120 * MIN),
        updatedAt: iso(120 * MIN),
        scheduledAt: iso(1000),
      })
    );

    await runTicks();

    const ride = await store().getRide('ride_sched_stamp');
    expect(ride?.searchStartedAt).toBeDefined();
    // Stamped at promotion time, not at booking time.
    expect(Date.now() - new Date(ride!.searchStartedAt!).getTime()).toBeLessThan(60 * 1000);
  });

  it('leaves a future-dated ride alone', async () => {
    await store().saveRide(
      mkRide('ride_sched_future', {
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + 60 * MIN).toISOString(),
      })
    );

    await runTicks();

    expect(await statusOf('ride_sched_future')).toBe('scheduled');
  });

  it('still auto-cancels a search that has genuinely run too long', async () => {
    // The timeout must keep working — the fix moves the clock's origin, it
    // doesn't disable the clock.
    await store().saveRide(
      mkRide('ride_stale_search', {
        status: 'searching',
        createdAt: iso(40 * MIN),
        updatedAt: iso(40 * MIN),
        searchStartedAt: iso(40 * MIN),
      })
    );

    await runTicks();

    expect(await statusOf('ride_stale_search')).toBe('cancelled');
  });

  it('ages a legacy ride with no searchStartedAt from updatedAt', async () => {
    // Rides already in flight when this deploys have no searchStartedAt.
    await store().saveRide(
      mkRide('ride_legacy_fresh', {
        status: 'searching',
        createdAt: iso(300 * MIN),
        updatedAt: iso(1000),
      })
    );

    await runTicks();

    expect(await statusOf('ride_legacy_fresh')).toBe('searching');
  });
});

describe('ride creation stamps the search clock', () => {
  it('sets searchStartedAt on an immediate ride', async () => {
    const auth = { Authorization: `Bearer ${signToken({ uid: 'p_immediate', role: 'passenger' })}` };
    const res = await request(app)
      .post('/api/rides')
      .set(auth)
      .send({
        pickup: { lat: 52.23, lng: 21.01, address: 'A' },
        destination: { lat: 52.2, lng: 21.05, address: 'B' },
        vehicleType: 'economy',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('searching');
    expect(res.body.searchStartedAt).toBeDefined();
  });

  it('does not set it on a ride booked for later', async () => {
    const auth = { Authorization: `Bearer ${signToken({ uid: 'p_later', role: 'passenger' })}` };
    const res = await request(app)
      .post('/api/rides')
      .set(auth)
      .send({
        pickup: { lat: 52.23, lng: 21.01, address: 'A' },
        destination: { lat: 52.2, lng: 21.05, address: 'B' },
        vehicleType: 'economy',
        scheduledAt: new Date(Date.now() + 120 * MIN).toISOString(),
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('scheduled');
    expect(res.body.searchStartedAt).toBeUndefined();
  });
});
