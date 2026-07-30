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
