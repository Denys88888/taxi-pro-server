import request from 'supertest';
import { createApp } from '../src/app';
import { store } from '../src/models';
import { signToken } from '../src/utils/jwt';
import type { Ride, RideStatus } from '../src/types';

// A driver's "I've arrived" / "Start ride" / "Complete ride" used to be
// fire-and-forget WebSocket frames. A phone whose connection has gone
// half-open — routine on mobile, and invisible, because readyState still reads
// OPEN — writes the frame into nothing and moves its own screen on while the
// server never hears. The road test found the consequence: reload mid-trip and
// navigation guided back to the passenger, because as far as the server knew
// the ride was still 'arrived'. A lost 'completed' is worse: an unsettled fare.
//
// Over HTTP the server answers, so the app can follow it instead of its own
// guess — and the call has to be safe to repeat, or a timeout leaves the driver
// with a button they daren't press again.

const app = createApp();

const DRIVER = 'd_status';
const PASSENGER = 'p_status';

const asDriver = (uid = DRIVER): Record<string, string> => ({
  Authorization: `Bearer ${signToken({ uid, role: 'driver' })}`,
});
const asPassenger = (): Record<string, string> => ({
  Authorization: `Bearer ${signToken({ uid: PASSENGER, role: 'passenger' })}`,
});

let seq = 0;
async function rideIn(status: RideStatus, patch: Partial<Ride> = {}): Promise<Ride> {
  const now = new Date().toISOString();
  const ride = {
    id: `r_status_${++seq}`,
    passengerId: PASSENGER,
    driverId: DRIVER,
    pickup: { lat: 52.23, lng: 21.01 },
    destination: { lat: 52.2, lng: 21.05 },
    vehicleType: 'economy',
    distanceKm: 5,
    estimatedDurationMin: 10,
    fare: 10,
    platformFeePercent: 10,
    platformFee: 1,
    driverEarnings: 9,
    status,
    createdAt: now,
    updatedAt: now,
    ...patch,
  } as Ride;
  await store().saveRide(ride);
  return ride;
}

const setStatus = (rideId: string, status: string, headers = asDriver()) =>
  request(app).post(`/api/rides/${rideId}/status`).set(headers).send({ status });

describe('POST /api/rides/:id/status', () => {
  it('walks the ride along and answers with the ride itself', async () => {
    const ride = await rideIn('assigned');

    const res = await setStatus(ride.id, 'arrived');

    expect(res.status).toBe(200);
    // The body is what the app should trust, instead of advancing on its own.
    expect(res.body.status).toBe('arrived');
    expect((await store().getRide(ride.id))!.status).toBe('arrived');
  });

  // The reason this is HTTP and not a socket frame: a request that times out
  // has to be safe to send again.
  it('treats repeating a state the ride already reached as success', async () => {
    const ride = await rideIn('in_progress');

    const first = await setStatus(ride.id, 'completed');
    const retry = await setStatus(ride.id, 'completed');

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('completed');
  });

  it('stamps the arrival time, so the free cancellation window can start', async () => {
    const ride = await rideIn('assigned');

    await setStatus(ride.id, 'arrived');

    expect((await store().getRide(ride.id))!.arrivedAt).toBeTruthy();
  });

  // Ownership is checked, and so is state — the pattern this codebase has been
  // bitten by before is checking only the first.
  it('refuses to skip a step', async () => {
    const ride = await rideIn('assigned');

    const res = await setStatus(ride.id, 'completed');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect((await store().getRide(ride.id))!.status).toBe('assigned');
  });

  it('refuses to drag a ride backwards', async () => {
    const ride = await rideIn('in_progress');

    const res = await setStatus(ride.id, 'arrived');

    expect(res.status).toBe(409);
    expect((await store().getRide(ride.id))!.status).toBe('in_progress');
  });

  it('will not let another driver move someone else\'s ride', async () => {
    const ride = await rideIn('assigned');

    const res = await setStatus(ride.id, 'arrived', asDriver('d_someone_else'));

    expect(res.status).toBe(403);
    expect((await store().getRide(ride.id))!.status).toBe('assigned');
  });

  // The passenger has a cancel endpoint of their own; they do not get to say
  // the driver has arrived or that the trip is over.
  it('is closed to passengers', async () => {
    const ride = await rideIn('assigned');

    const res = await setStatus(ride.id, 'arrived', asPassenger());

    expect(res.status).toBe(403);
  });

  it('404s on a ride that does not exist', async () => {
    expect((await setStatus('r_nope', 'arrived')).status).toBe(404);
  });

  it.each(['searching', 'cancelled', 'completed', 'scheduled'])(
    'rejects an unknown target status (%s is not a driver transition)',
    async (status) => {
      const ride = await rideIn('assigned');
      // 'completed' from 'assigned' is a skipped step, the rest are not the
      // driver's to set at all — either way the schema or the guard refuses.
      const res = await setStatus(ride.id, status);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await store().getRide(ride.id))!.status).toBe('assigned');
    }
  );
});
