import request from 'supertest';
import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';
import { store } from '../src/models';
import { nowIso, genId } from '../src/utils/helpers';
import { payoutDriver } from '../src/controllers/paymentController';
import type { User, Ride } from '../src/types';

// Paying a driver twice is the worst failure this system can have, so the
// guard against it is covered directly. The dangerous case is a partial
// failure: the Stellar transfer settles but Pi's bookkeeping call fails, which
// records a txid alongside a non-completed status. Anything that treats that
// row as "unpaid" and re-sends would double-pay a real person.

const app = createApp();

const ADMIN = 'admin_payout_test';
function adminAuth() {
  return { Authorization: `Bearer ${signToken({ uid: ADMIN, role: 'admin' })}` };
}

async function seedUser(uid: string, role: User['role']): Promise<void> {
  await store().saveUser({
    uid,
    role,
    name: uid,
    rating: 5,
    ratingCount: 0,
    isBlocked: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as User);
}

// A completed, fully-paid ride whose driver payout hit the partial-failure
// path: funds transferred (txid present), Pi complete failed.
async function seedRideWithSettledTransfer(overrides: Partial<Ride> = {}): Promise<Ride> {
  const ride: Ride = {
    id: genId('ride'),
    passengerId: 'pax_payout_test',
    driverId: 'drv_payout_test',
    pickup: { lat: 52.23, lng: 21.01 },
    destination: { lat: 52.2, lng: 21.05 },
    vehicleType: 'economy',
    distanceKm: 5,
    estimatedDurationMin: 10,
    fare: 10,
    platformFeePercent: 10,
    platformFee: 1,
    driverEarnings: 9,
    status: 'completed',
    paymentStatus: 'completed',
    driverPayoutStatus: 'sent_unconfirmed',
    driverPayoutTxid: 'stellar_tx_already_settled',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  } as Ride;
  await store().saveRide(ride);
  return ride;
}

beforeAll(async () => {
  await seedUser(ADMIN, 'admin');
  await seedUser('pax_payout_test', 'passenger');
  await seedUser('drv_payout_test', 'driver');
});

describe('payout double-send protection', () => {
  it('payoutDriver refuses to re-send when a txid is already recorded', async () => {
    const ride = await seedRideWithSettledTransfer();

    await payoutDriver(ride, 'fare', ride.driverEarnings);

    const after = await store().getRide(ride.id);
    // Untouched: no new transfer, the original txid and status preserved.
    expect(after?.driverPayoutTxid).toBe('stellar_tx_already_settled');
    expect(after?.driverPayoutStatus).toBe('sent_unconfirmed');
  });

  it('refuses even when the status was left at failed, since the txid is what proves funds moved', async () => {
    const ride = await seedRideWithSettledTransfer({
      driverPayoutStatus: 'failed',
      driverPayoutTxid: 'stellar_tx_from_failed_row',
    });

    await payoutDriver(ride, 'fare', ride.driverEarnings);

    const after = await store().getRide(ride.id);
    expect(after?.driverPayoutTxid).toBe('stellar_tx_from_failed_row');
    expect(after?.driverPayoutStatus).toBe('failed');
  });

  it('admin retry returns 409 instead of silently doing nothing', async () => {
    const ride = await seedRideWithSettledTransfer();

    const res = await request(app)
      .post(`/api/admin/rides/${ride.id}/retry-payout`)
      .set(adminAuth())
      .send({ kind: 'fare' });

    expect(res.status).toBe(409);
    expect(res.body.txid).toBe('stellar_tx_already_settled');
    expect(String(res.body.error)).toMatch(/already transferred/i);
  });

  it('lists a settled-but-unconfirmed payout as non-retryable, with its txid', async () => {
    const ride = await seedRideWithSettledTransfer();

    const res = await request(app).get('/api/admin/unpaid-payouts').set(adminAuth());
    expect(res.status).toBe(200);

    const row = (res.body as Array<Record<string, unknown>>).find(
      (r) => r.id === ride.id && r.kind === 'fare'
    );
    expect(row).toBeDefined();
    // Visible to the operator, but the UI must not offer a retry for it.
    expect(row!.retryable).toBe(false);
    expect(row!.txid).toBe('stellar_tx_already_settled');
  });

  it('a genuinely failed payout with no txid stays retryable', async () => {
    const ride = await seedRideWithSettledTransfer({
      driverPayoutStatus: 'failed',
      driverPayoutTxid: undefined,
      driverPayoutError: 'network error before submit',
    });

    const res = await request(app).get('/api/admin/unpaid-payouts').set(adminAuth());
    const row = (res.body as Array<Record<string, unknown>>).find(
      (r) => r.id === ride.id && r.kind === 'fare'
    );
    expect(row).toBeDefined();
    expect(row!.retryable).toBe(true);
  });
});

// A cancellation fee is the only payout that lives on a ride which never
// completed. Everything that finds unpaid money used to filter on
// status === 'completed' first, so a driver could be owed a fee with nothing
// anywhere able to show it or send it.
describe('cancellation-fee payouts are visible and retryable', () => {
  // A cancelled ride whose fee the passenger paid, but whose A2U transfer to
  // the driver never went out.
  async function seedUnpaidFee(overrides: Partial<Ride> = {}): Promise<Ride> {
    const ride: Ride = {
      id: genId('ride'),
      passengerId: 'pax_payout_test',
      driverId: 'drv_payout_test',
      pickup: { lat: 52.23, lng: 21.01 },
      destination: { lat: 52.2, lng: 21.05 },
      vehicleType: 'economy',
      distanceKm: 5,
      estimatedDurationMin: 10,
      fare: 10,
      platformFeePercent: 10,
      platformFee: 1,
      driverEarnings: 9,
      status: 'cancelled',
      paymentStatus: 'cancelled',
      cancellationFee: 5,
      cancellationFeeStatus: 'paid',
      cancellationFeeDriverEarnings: 4.5,
      cancellationFeeTxid: 'tx_fee_paid_by_passenger',
      feePayoutStatus: 'failed',
      feePayoutError: 'wallet unreachable',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...overrides,
    } as Ride;
    await store().saveRide(ride);
    return ride;
  }

  it('lists the fee a driver is still owed on a cancelled ride', async () => {
    const ride = await seedUnpaidFee();

    const res = await request(app).get('/api/admin/unpaid-payouts').set(adminAuth());
    const row = (res.body as Array<Record<string, unknown>>).find(
      (r) => r.id === ride.id && r.kind === 'fee'
    );
    expect(row).toBeDefined();
    // The driver's share of the fee, not the fee and not the refunded fare.
    expect(row!.amount).toBe(4.5);
    expect(row!.retryable).toBe(true);
  });

  it('does not list a fee that was never paid by the passenger', async () => {
    const ride = await seedUnpaidFee({
      cancellationFeeStatus: 'outstanding',
      cancellationFeeTxid: undefined,
      feePayoutStatus: undefined,
    });

    const res = await request(app).get('/api/admin/unpaid-payouts').set(adminAuth());
    const row = (res.body as Array<Record<string, unknown>>).find(
      (r) => r.id === ride.id && r.kind === 'fee'
    );
    // Nothing has been collected, so there is nothing to hand on.
    expect(row).toBeUndefined();
  });

  it('lets the operator retry it even though the ride never completed', async () => {
    const ride = await seedUnpaidFee();

    const res = await request(app)
      .post(`/api/admin/rides/${ride.id}/retry-payout`)
      .set(adminAuth())
      .send({ kind: 'fee' });

    // Reaches the payout instead of being turned away by the fare gate. No
    // PI_WALLET_SEED in tests, so it stops at the wallet rather than at a
    // 409 about a fare this ride never had.
    expect(res.status).toBe(200);
    expect(res.body.driverPayoutStatus).toBe('no_wallet_configured');
    const after = await store().getRide(ride.id);
    expect(after?.driverPayoutStatus).toBeUndefined();
    expect(after?.tipPayoutStatus).toBeUndefined();
  });

  it('refuses to re-send a fee whose transfer already settled', async () => {
    const ride = await seedUnpaidFee({
      feePayoutStatus: 'sent_unconfirmed',
      feePayoutTxid: 'stellar_fee_already_settled',
    });

    const res = await request(app)
      .post(`/api/admin/rides/${ride.id}/retry-payout`)
      .set(adminAuth())
      .send({ kind: 'fee' });

    expect(res.status).toBe(409);
    expect(res.body.txid).toBe('stellar_fee_already_settled');
  });
});

// The production outage this pins down: a Firestore `8 RESOURCE_EXHAUSTED`
// raised inside a payout that nobody awaits (every caller uses
// `void payoutDriver(...)`) became an unhandled promise rejection, and Node
// exits the process for those. One ride's payout killed the whole API —
// every socket, every in-flight request — and did it again on the next tick.
describe('a payout that hits a broken database', () => {
  it('settles instead of rejecting, because no caller is there to catch it', async () => {
    const ride = await seedRideWithSettledTransfer({
      driverPayoutStatus: undefined,
      driverPayoutTxid: undefined,
    });
    const quotaExceeded = jest
      .spyOn(store(), 'updateRide')
      .mockRejectedValue(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.'));

    await expect(payoutDriver(ride, 'fare', ride.driverEarnings)).resolves.toBeUndefined();

    expect(quotaExceeded).toHaveBeenCalled();
    quotaExceeded.mockRestore();
  });
});
