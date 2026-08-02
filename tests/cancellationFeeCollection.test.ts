import request from 'supertest';
import { createApp } from '../src/app';
import { store } from '../src/models';
import { signToken } from '../src/utils/jwt';
import { nowIso } from '../src/utils/helpers';
import { getPiPayment, cancelPayment } from '../src/services/piService';

// The Pi API is never reached from tests. approve/complete report success so the
// fee can be driven end to end; payoutToUser is stubbed so the driver's A2U
// transfer doesn't try to sign anything.
jest.mock('../src/services/piService', () => ({
  verifyPiAccessToken: jest.fn(),
  approvePayment: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
  completePayment: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
  cancelPayment: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
  getPiPayment: jest.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
  payoutToUser: jest.fn().mockResolvedValue({ txid: 'stellar_fee_payout' }),
}));


const app = createApp();

const piGet = getPiPayment as jest.MockedFunction<typeof getPiPayment>;
const piCancel = cancelPayment as jest.MockedFunction<typeof cancelPayment>;

beforeEach(() => {
  piGet.mockClear();
  piCancel.mockClear();
  piGet.mockResolvedValue({ ok: true, status: 200, data: {} } as never);
});

const pickup = { lat: 52.23, lng: 21.01, address: 'A' };
const destination = { lat: 52.2, lng: 21.05, address: 'B' };

const authFor = (uid: string): Record<string, string> => ({
  Authorization: `Bearer ${signToken({ uid, role: 'passenger', username: uid })}`,
});

async function seedUser(uid: string, role: 'passenger' | 'driver'): Promise<void> {
  const now = nowIso();
  await store().saveUser({
    uid, role, name: uid, rating: 5, ratingCount: 0,
    isBlocked: false, createdAt: now, updatedAt: now,
  } as never);
}

// A ride the passenger cancelled late — the state cancelRide leaves behind.
async function cancelledLate(
  passengerUid: string,
  driverUid: string
): Promise<{ id: string; fare: number; fee: number }> {
  await seedUser(passengerUid, 'passenger');
  await seedUser(driverUid, 'driver');
  const created = await request(app)
    .post('/api/rides')
    .set(authFor(passengerUid))
    .send({ pickup, destination, vehicleType: 'economy' });
  expect(created.status).toBe(201);
  await store().updateRide(created.body.id, { status: 'in_progress', driverId: driverUid });
  const res = await request(app)
    .post(`/api/rides/${created.body.id}/cancel`)
    .set(authFor(passengerUid))
    .send({ reason: 'late-cancel' });
  expect(res.status).toBe(200);
  return { id: created.body.id, fare: created.body.fare, fee: res.body.cancellationFee };
}

describe('a late cancellation leaves a debt, not a silent write-off', () => {
  it('marks the fee outstanding', async () => {
    const { id, fare, fee } = await cancelledLate('feepax1', 'feedrv1');
    expect(fee).toBeCloseTo(fare / 2, 2);
    const ride = await store().getRide(id);
    expect(ride?.cancellationFeeStatus).toBe('outstanding');
  });

  it('leaves no debt behind a free cancellation', async () => {
    await seedUser('feepax2', 'passenger');
    const created = await request(app)
      .post('/api/rides')
      .set(authFor('feepax2'))
      .send({ pickup, destination, vehicleType: 'economy' });
    const res = await request(app)
      .post(`/api/rides/${created.body.id}/cancel`)
      .set(authFor('feepax2'))
      .send({ reason: 'user-cancel' });
    expect(res.body.cancellationFee).toBe(0);
    const ride = await store().getRide(created.body.id);
    expect(ride?.cancellationFeeStatus).toBeUndefined();
  });

  it('refunds the escrowed fare in full — the fee is collected separately', async () => {
    const { id } = await cancelledLate('feepax3', 'feedrv3');
    const ride = await store().getRide(id);
    // Pi cannot capture part of a held payment, so the hold is released whole.
    expect(ride?.paymentStatus).not.toBe('held');
  });
});

describe('an outstanding fee blocks the next booking', () => {
  it('refuses a new ride and names the amount', async () => {
    const { id, fee } = await cancelledLate('feepax4', 'feedrv4');
    const res = await request(app)
      .post('/api/rides')
      .set(authFor('feepax4'))
      .send({ pickup, destination, vehicleType: 'economy' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCELLATION_FEE_DUE');
    expect(res.body.rideId).toBe(id);
    expect(res.body.amount).toBeCloseTo(fee, 2);
  });

  it('reports the debt on GET /api/rides/outstanding-fee', async () => {
    const { id, fee } = await cancelledLate('feepax5', 'feedrv5');
    const res = await request(app).get('/api/rides/outstanding-fee').set(authFor('feepax5'));
    expect(res.status).toBe(200);
    expect(res.body.rideId).toBe(id);
    expect(res.body.amount).toBeCloseTo(fee, 2);
  });

  it('reports nothing for a passenger who owes nothing', async () => {
    await seedUser('feepax6', 'passenger');
    const res = await request(app).get('/api/rides/outstanding-fee').set(authFor('feepax6'));
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('does not bill the driver of a ride the passenger cancelled', async () => {
    await cancelledLate('feepax7', 'feedrv7');
    // The driver is on the same ride, and listRidesByUser matches either side of
    // it. Only the passenger owes the fee.
    const res = await request(app).get('/api/rides/outstanding-fee').set(authFor('feedrv7'));
    expect(res.body).toBeNull();
    const booking = await request(app)
      .post('/api/rides')
      .set(authFor('feedrv7'))
      .send({ pickup, destination, vehicleType: 'economy' });
    expect(booking.status).toBe(201);
  });
});

describe('paying the fee', () => {
  it('charges what the ride says, not what the client asks for', async () => {
    const { id, fee } = await cancelledLate('feepax8', 'feedrv8');
    const res = await request(app)
      .post('/api/payments')
      .set(authFor('feepax8'))
      .send({ rideId: id, type: 'fee', amount: 0.01 });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBeCloseTo(fee, 2);
  });

  it('splits it like a fare — the driver is being compensated, not tipped', async () => {
    const { id, fee } = await cancelledLate('feepax9', 'feedrv9');
    const created = await request(app)
      .post('/api/payments')
      .set(authFor('feepax9'))
      .send({ rideId: id, type: 'fee' });
    const payment = await store().getPayment(created.body.paymentId);
    expect(payment?.platformFee).toBeGreaterThan(0);
    expect(payment!.driverEarnings + payment!.platformFee).toBeCloseTo(fee, 2);
  });

  it('refuses when nothing is owed on the ride', async () => {
    await seedUser('feepax10', 'passenger');
    const created = await request(app)
      .post('/api/rides')
      .set(authFor('feepax10'))
      .send({ pickup, destination, vehicleType: 'economy' });
    const res = await request(app)
      .post('/api/payments')
      .set(authFor('feepax10'))
      .send({ rideId: created.body.id, type: 'fee' });
    expect(res.status).toBe(409);
  });

  it('does not put the cancelled ride back on hold when approved', async () => {
    const { id } = await cancelledLate('feepax11', 'feedrv11');
    const created = await request(app)
      .post('/api/payments')
      .set(authFor('feepax11'))
      .send({ rideId: id, type: 'fee' });
    await request(app)
      .post(`/api/payments/${created.body.paymentId}/approve`)
      .set(authFor('feepax11'))
      .send({ piPaymentId: 'pi-fee-approve' });
    const ride = await store().getRide(id);
    // The fare was refunded when the ride was cancelled. Showing it as held
    // again would tell the passenger money is escrowed for a trip that is over.
    expect(ride?.paymentStatus).not.toBe('held');
  });

  it('settles the debt, pays the driver, and unblocks booking', async () => {
    const { id } = await cancelledLate('feepax12', 'feedrv12');
    const created = await request(app)
      .post('/api/payments')
      .set(authFor('feepax12'))
      .send({ rideId: id, type: 'fee' });
    const done = await request(app)
      .post(`/api/payments/${created.body.paymentId}/complete`)
      .set(authFor('feepax12'))
      .send({ piPaymentId: 'pi-fee-1', txid: 'tx-fee-1' });
    expect(done.status).toBe(200);

    const ride = await store().getRide(id);
    expect(ride?.cancellationFeeStatus).toBe('paid');
    expect(ride?.cancellationFeeTxid).toBe('tx-fee-1');

    // The driver's share is queued under the fee's own fields, so a fee payout
    // can never be mistaken for a fare or tip payout — the bug the old chain of
    // ternaries would have introduced, filing every third kind under the tip.
    // No PI_WALLET_SEED in tests, so it stops at 'no_wallet_configured' rather
    // than reaching the wallet; which field it lands in is the point here.
    await new Promise((r) => setTimeout(r, 150));
    const settled = await store().getRide(id);
    expect(settled?.feePayoutStatus).toBe('no_wallet_configured');
    expect(settled?.driverPayoutStatus).toBeUndefined();
    expect(settled?.tipPayoutStatus).toBeUndefined();

    const booking = await request(app)
      .post('/api/rides')
      .set(authFor('feepax12'))
      .send({ pickup, destination, vehicleType: 'economy' });
    expect(booking.status).toBe(201);
  });
});

// A second payment sheet for a fee Pi is already holding would take it twice,
// and the debt keeps blocking every booking until something resolves it — so
// a retry must reconcile the earlier attempt rather than stack on top of it.
describe('retrying a fee payment that was left half-finished', () => {
  // Drive a fee payment to 'approved': the passenger okayed it in the wallet
  // and Pi is holding the money, but our completion call never landed.
  async function approvedFee(
    pax: string,
    drv: string
  ): Promise<{ id: string; paymentId: string; fee: number }> {
    const { id, fee } = await cancelledLate(pax, drv);
    const created = await request(app)
      .post('/api/payments')
      .set(authFor(pax))
      .send({ rideId: id, type: 'fee' });
    await request(app)
      .post(`/api/payments/${created.body.paymentId}/approve`)
      .set(authFor(pax))
      .send({ piPaymentId: `pi-${pax}` });
    return { id, paymentId: created.body.paymentId, fee };
  }

  it('lets a fresh attempt through when the wallet never opened', async () => {
    const { id } = await cancelledLate('feepax13', 'feedrv13');
    const first = await request(app)
      .post('/api/payments')
      .set(authFor('feepax13'))
      .send({ rideId: id, type: 'fee' });
    const second = await request(app)
      .post('/api/payments')
      .set(authFor('feepax13'))
      .send({ rideId: id, type: 'fee' });
    // 'created' means our record exists but Pi was never told anything, so
    // there is no hold to protect and nothing to reconcile.
    expect(second.status).toBe(201);
    expect(second.body.paymentId).not.toBe(first.body.paymentId);
    expect(piGet).not.toHaveBeenCalled();
  });

  it('settles the debt from Pi when Pi says it already captured the fee', async () => {
    const { id } = await approvedFee('feepax14', 'feedrv14');
    piGet.mockResolvedValue({
      ok: true,
      status: 200,
      data: { transaction: { txid: 'tx-recovered-fee' } },
    } as never);

    const retry = await request(app)
      .post('/api/payments')
      .set(authFor('feepax14'))
      .send({ rideId: id, type: 'fee' });
    // Charging again would take the fee twice for one cancellation.
    expect(retry.status).toBe(409);

    const ride = await store().getRide(id);
    expect(ride?.cancellationFeeStatus).toBe('paid');
    expect(ride?.cancellationFeeTxid).toBe('tx-recovered-fee');

    const booking = await request(app)
      .post('/api/rides')
      .set(authFor('feepax14'))
      .send({ pickup, destination, vehicleType: 'economy' });
    expect(booking.status).toBe(201);
  });

  it('drops the stale hold and reissues when Pi never captured it', async () => {
    const { id, paymentId } = await approvedFee('feepax15', 'feedrv15');
    // piGet resolves with no transaction — the hold is real but unspent.
    const retry = await request(app)
      .post('/api/payments')
      .set(authFor('feepax15'))
      .send({ rideId: id, type: 'fee' });
    expect(retry.status).toBe(201);
    expect(retry.body.paymentId).not.toBe(paymentId);
    expect(piCancel).toHaveBeenCalledWith('pi-feepax15');

    const stale = await store().getPayment(paymentId);
    expect(stale?.status).toBe('cancelled');
    const ride = await store().getRide(id);
    // Still owed — only Pi confirming the transfer may clear it.
    expect(ride?.cancellationFeeStatus).toBe('outstanding');
  });
});
