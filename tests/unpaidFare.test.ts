import request from 'supertest';
import { createApp } from '../src/app';
import { store } from '../src/models';
import { signToken } from '../src/utils/jwt';
import type { Ride, RidePaymentStatus } from '../src/types';

// From a road test: the passenger closed the Pi payment sheet after being
// driven somewhere, and ordered another taxi straight away. Pi has no card on
// file, so that fare is simply gone — and it is the driver who is out of
// pocket, since their share is paid out of a fare that never arrived. The gate
// for an unpaid cancellation fee already existed; the fare itself had none.

const app = createApp();

const authFor = (uid: string): Record<string, string> => ({
  Authorization: `Bearer ${signToken({ uid, role: 'passenger' })}`,
});

function order(uid: string) {
  return request(app)
    .post('/api/rides')
    .set(authFor(uid))
    .send({
      pickup: { lat: 52.23, lng: 21.01, address: 'A' },
      destination: { lat: 52.2, lng: 21.05, address: 'B' },
      vehicleType: 'economy',
    });
}

let seq = 0;
async function finishedRide(passengerId: string, patch: Partial<Ride>): Promise<Ride> {
  const now = new Date().toISOString();
  const ride = {
    id: `r_unpaid_${++seq}`,
    passengerId,
    driverId: 'd_1',
    pickup: { lat: 52.23, lng: 21.01 },
    destination: { lat: 52.2, lng: 21.05 },
    vehicleType: 'economy',
    distanceKm: 4.7,
    estimatedDurationMin: 8,
    fare: 4.14,
    platformFeePercent: 10,
    platformFee: 0.41,
    driverEarnings: 3.73,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    ...patch,
  } as Ride;
  await store().saveRide(ride);
  return ride;
}

describe('ordering after a ride that was never paid for', () => {
  it('refuses the next ride and says what is owed', async () => {
    const uid = 'p_unpaid_none';
    const owed = await finishedRide(uid, { paymentStatus: undefined });

    const res = await order(uid);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UNPAID_RIDE');
    // The client offers to settle it on the spot, so it needs both.
    expect(res.body.rideId).toBe(owed.id);
    expect(res.body.amount).toBe(4.14);
  });

  // A payment row created and never approved moved no money at all.
  it('counts a payment left pending as unpaid', async () => {
    const uid = 'p_unpaid_pending';
    await finishedRide(uid, { paymentStatus: 'pending' });

    expect((await order(uid)).body.code).toBe('UNPAID_RIDE');
  });

  it('counts a cancelled payment as unpaid', async () => {
    const uid = 'p_unpaid_cancelled';
    await finishedRide(uid, { paymentStatus: 'cancelled' });

    expect((await order(uid)).body.code).toBe('UNPAID_RIDE');
  });

  // Escrow: the money has already left the passenger's wallet and is ours to
  // release. Blocking here would refuse a ride to someone who has in fact paid.
  it.each<RidePaymentStatus>(['held', 'completed', 'refunded'])(
    'lets the passenger order again after a %s payment',
    async (paymentStatus) => {
      const uid = `p_settled_${paymentStatus}`;
      await finishedRide(uid, { paymentStatus });

      expect((await order(uid)).status).toBe(201);
    }
  );

  // A zero fare with no payment row would otherwise lock the passenger out for
  // good, with nothing they could pay to get out of it.
  it('ignores a finished ride that cost nothing', async () => {
    const uid = 'p_free_ride';
    await finishedRide(uid, { fare: 0, paymentStatus: undefined });

    expect((await order(uid)).status).toBe(201);
  });

  // Completed rides come back from the same collection for both parties.
  // Charging a driver for having driven would be absurd.
  it('does not hold a driver responsible for the passenger not paying', async () => {
    const uid = 'p_was_driver';
    await finishedRide('someone_else', { driverId: uid, paymentStatus: undefined });

    expect((await order(uid)).status).toBe(201);
  });

  // The bug the owner hit: they paid the ride the refusal named, ordered again,
  // and were refused over the one behind it. A backlog like that cannot form in
  // normal running — an unpaid ride blocks the next order, so there is never a
  // second one to go unpaid — it only exists from before this rule was added.
  // Paying the last ride has to be enough to get moving again.
  it('lets the passenger order once their LAST ride is paid, whatever is behind it', async () => {
    const uid = 'p_backlog';
    // Three old test rides nobody ever paid for, then a recent one that is.
    await finishedRide(uid, { paymentStatus: undefined });
    await finishedRide(uid, { paymentStatus: undefined });
    await finishedRide(uid, { paymentStatus: 'cancelled' });
    await new Promise((r) => setTimeout(r, 5)); // ordering is by createdAt
    await finishedRide(uid, { paymentStatus: 'completed' });

    expect((await order(uid)).status).toBe(201);
  });

  // …and the other way round: an old paid ride does not excuse the last one.
  it('still refuses when the last ride is the unpaid one', async () => {
    const uid = 'p_last_unpaid';
    await finishedRide(uid, { paymentStatus: 'completed' });
    await new Promise((r) => setTimeout(r, 5));
    const owed = await finishedRide(uid, { paymentStatus: undefined });

    const res = await order(uid);
    expect(res.status).toBe(409);
    expect(res.body.rideId).toBe(owed.id);
  });
});
