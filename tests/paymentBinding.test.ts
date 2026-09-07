import request from 'supertest';

// The hole these pin: `piPaymentId` arrives in the request body, so the caller
// chooses it. Owning the ride was checked; naming the right Pi payment was not.
// The two identifiers were independent, which let a passenger pair their own
// payment record with any Pi payment id they knew and have the server approve,
// complete or cancel it for them.
const getPiPayment = jest.fn();
const approvePayment = jest.fn();
const completePayment = jest.fn();
const cancelPayment = jest.fn();

jest.mock('../src/services/piService', () => ({
  getPiPayment: (...args: unknown[]) => getPiPayment(...args),
  approvePayment: (...args: unknown[]) => approvePayment(...args),
  completePayment: (...args: unknown[]) => completePayment(...args),
  cancelPayment: (...args: unknown[]) => cancelPayment(...args),
  payoutToUser: jest.fn().mockResolvedValue({ txid: 'tx_payout' }),
  verifyPiAccessToken: jest.fn(),
}));

import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';
import { store } from '../src/models';
import type { Payment, Ride } from '../src/types';

const app = createApp();

const PASSENGER = 'passenger_binding';
const auth = { Authorization: `Bearer ${signToken({ uid: PASSENGER, role: 'passenger' })}` };

const nowIso = new Date().toISOString();

async function seed(paymentId: string, over: Partial<Payment> = {}): Promise<void> {
  const rideId = `ride_${paymentId}`;
  await store().saveRide({
    id: rideId,
    passengerId: PASSENGER,
    driverId: 'driver_binding',
    status: 'completed',
    pickup: { lat: 0, lng: 0 },
    destination: { lat: 1, lng: 1 },
    distanceKm: 3,
    estimatedDurationMin: 10,
    fare: 10,
    platformFeePercent: 10,
    platformFee: 1,
    driverEarnings: 9,
    paymentStatus: 'pending',
    paymentId,
    createdAt: nowIso,
    updatedAt: nowIso,
  } as unknown as Ride);
  await store().savePayment({
    id: paymentId,
    rideId,
    type: 'ride',
    amount: 10,
    platformFeePercent: 10,
    platformFee: 1,
    driverEarnings: 9,
    status: 'created',
    createdAt: nowIso,
    updatedAt: nowIso,
    ...over,
  } as Payment);
}

beforeEach(() => {
  jest.clearAllMocks();
  approvePayment.mockResolvedValue({ ok: true, status: 200, data: {} });
  completePayment.mockResolvedValue({ ok: true, status: 200, data: {} });
  cancelPayment.mockResolvedValue({ ok: true, status: 200, data: {} });
});

// A Pi payment that really was opened for `paymentId`, by this passenger.
const piRecordFor = (paymentId: string, txid?: string) => ({
  ok: true,
  status: 200,
  data: {
    user_uid: PASSENGER,
    metadata: { paymentId },
    ...(txid ? { transaction: { txid } } : {}),
  },
});

describe('first binding is verified against Pi', () => {
  it('approve refuses a Pi payment opened for a different local record', async () => {
    await seed('pay_bind_a');
    // Pi says: yours, but opened for someone else's record.
    getPiPayment.mockResolvedValue(piRecordFor('pay_someone_else'));

    const res = await request(app)
      .post('/api/payments/pay_bind_a/approve')
      .set(auth)
      .send({ piPaymentId: 'pi_wrong_record' });

    expect(res.status).toBe(409);
    expect(approvePayment).not.toHaveBeenCalled();
  });

  it('approve refuses a Pi payment belonging to another user', async () => {
    await seed('pay_bind_b');
    getPiPayment.mockResolvedValue({
      ok: true,
      status: 200,
      data: { user_uid: 'someone_else', metadata: { paymentId: 'pay_bind_b' } },
    });

    const res = await request(app)
      .post('/api/payments/pay_bind_b/approve')
      .set(auth)
      .send({ piPaymentId: 'pi_other_user' });

    expect(res.status).toBe(403);
    expect(approvePayment).not.toHaveBeenCalled();
  });

  // piFetch substitutes {} for a body that will not parse, so an answer with no
  // owner in it reaches this code. Absent ownership is not proof of ownership.
  it('approve refuses when Pi names no owner at all', async () => {
    await seed('pay_bind_c');
    getPiPayment.mockResolvedValue({ ok: true, status: 200, data: {} });

    const res = await request(app)
      .post('/api/payments/pay_bind_c/approve')
      .set(auth)
      .send({ piPaymentId: 'pi_empty_body' });

    expect(res.status).toBe(403);
    expect(approvePayment).not.toHaveBeenCalled();
  });

  it('approve refuses when Pi cannot confirm the payment exists', async () => {
    await seed('pay_bind_d');
    getPiPayment.mockResolvedValue({ ok: false, status: 404, data: {} });

    const res = await request(app)
      .post('/api/payments/pay_bind_d/approve')
      .set(auth)
      .send({ piPaymentId: 'pi_missing' });

    expect(res.status).toBe(404);
    expect(approvePayment).not.toHaveBeenCalled();
  });

  it('approve still lets a correctly matched payment through', async () => {
    await seed('pay_bind_ok');
    getPiPayment.mockResolvedValue(piRecordFor('pay_bind_ok'));

    const res = await request(app)
      .post('/api/payments/pay_bind_ok/approve')
      .set(auth)
      .send({ piPaymentId: 'pi_correct' });

    expect(res.status).toBe(200);
    expect(approvePayment).toHaveBeenCalledWith('pi_correct');
    expect((await store().getPayment('pay_bind_ok'))?.piPaymentId).toBe('pi_correct');
  });
});

describe('an already-bound record only accepts its own Pi payment', () => {
  // The re-approve hole: the existing idempotency guard only short-circuits when
  // the ids match, so a *different* id used to fall straight through and
  // overwrite the stored binding that recoverStalePayment later reads.
  it('approve refuses to re-point a bound record at another Pi payment', async () => {
    await seed('pay_bound_a', { status: 'approved', piPaymentId: 'pi_original' });

    const res = await request(app)
      .post('/api/payments/pay_bound_a/approve')
      .set(auth)
      .send({ piPaymentId: 'pi_substitute' });

    expect(res.status).toBe(409);
    expect(approvePayment).not.toHaveBeenCalled();
    expect((await store().getPayment('pay_bound_a'))?.piPaymentId).toBe('pi_original');
  });

  it('cancel refuses a Pi payment that is not this record’s', async () => {
    await seed('pay_bound_b', { status: 'approved', piPaymentId: 'pi_mine' });

    const res = await request(app)
      .post('/api/payments/pay_bound_b/cancel')
      .set(auth)
      .send({ piPaymentId: 'pi_a_strangers_payment' });

    expect(res.status).toBe(409);
    expect(cancelPayment).not.toHaveBeenCalled();
  });

  it('cancel proceeds for the record’s own Pi payment', async () => {
    await seed('pay_bound_c', { status: 'approved', piPaymentId: 'pi_mine_c' });
    getPiPayment.mockResolvedValue(piRecordFor('pay_bound_c'));

    const res = await request(app)
      .post('/api/payments/pay_bound_c/cancel')
      .set(auth)
      .send({ piPaymentId: 'pi_mine_c' });

    expect(res.status).toBe(200);
    expect(cancelPayment).toHaveBeenCalledWith('pi_mine_c');
  });

  // An unreachable Pi must not strand a payment whose identity is already
  // settled — the stored id carries it.
  it('cancel falls through on the stored id when Pi is unreachable', async () => {
    await seed('pay_bound_d', { status: 'approved', piPaymentId: 'pi_mine_d' });
    getPiPayment.mockRejectedValue(new Error('network down'));

    const res = await request(app)
      .post('/api/payments/pay_bound_d/cancel')
      .set(auth)
      .send({ piPaymentId: 'pi_mine_d' });

    expect(res.status).toBe(200);
    expect(cancelPayment).toHaveBeenCalledWith('pi_mine_d');
  });

  // The opposite case: with nothing stored, Pi's answer *is* the identity, so an
  // unreachable Pi has to deny rather than bind on the client's word.
  it('approve denies when Pi is unreachable and nothing is bound yet', async () => {
    await seed('pay_bound_e');
    getPiPayment.mockRejectedValue(new Error('network down'));

    const res = await request(app)
      .post('/api/payments/pay_bound_e/approve')
      .set(auth)
      .send({ piPaymentId: 'pi_unverifiable' });

    expect(res.status).toBe(502);
    expect(approvePayment).not.toHaveBeenCalled();
  });
});

describe('complete checks the txid against Pi', () => {
  it('refuses a txid Pi does not have on this payment', async () => {
    await seed('pay_txid_a', { status: 'approved', piPaymentId: 'pi_txid_a' });
    getPiPayment.mockResolvedValue(piRecordFor('pay_txid_a', 'tx_real'));

    const res = await request(app)
      .post('/api/payments/pay_txid_a/complete')
      .set(auth)
      .send({ piPaymentId: 'pi_txid_a', txid: 'tx_borrowed' });

    expect(res.status).toBe(409);
    expect(completePayment).not.toHaveBeenCalled();
  });

  it('accepts the txid Pi actually recorded', async () => {
    await seed('pay_txid_b', { status: 'approved', piPaymentId: 'pi_txid_b' });
    getPiPayment.mockResolvedValue(piRecordFor('pay_txid_b', 'tx_real_b'));

    const res = await request(app)
      .post('/api/payments/pay_txid_b/complete')
      .set(auth)
      .send({ piPaymentId: 'pi_txid_b', txid: 'tx_real_b' });

    expect(res.status).toBe(200);
    expect(completePayment).toHaveBeenCalledWith('pi_txid_b', 'tx_real_b');
  });

  // The chain write can land before Pi has indexed it. Nothing to contradict,
  // and piComplete validates the txid anyway — so this must not block.
  it('proceeds when Pi has not indexed a transaction yet', async () => {
    await seed('pay_txid_c', { status: 'approved', piPaymentId: 'pi_txid_c' });
    getPiPayment.mockResolvedValue(piRecordFor('pay_txid_c'));

    const res = await request(app)
      .post('/api/payments/pay_txid_c/complete')
      .set(auth)
      .send({ piPaymentId: 'pi_txid_c', txid: 'tx_not_yet_indexed' });

    expect(res.status).toBe(200);
    expect(completePayment).toHaveBeenCalledWith('pi_txid_c', 'tx_not_yet_indexed');
  });
});

describe('existing guarantees still hold', () => {
  it('a completed payment stays idempotent and never re-enters Pi', async () => {
    await seed('pay_done', { status: 'completed', piPaymentId: 'pi_done', txid: 'tx_done' });

    const res = await request(app)
      .post('/api/payments/pay_done/complete')
      .set(auth)
      .send({ piPaymentId: 'pi_done', txid: 'tx_done' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_completed');
    expect(completePayment).not.toHaveBeenCalled();
  });

  it('ride ownership is still what gates the record itself', async () => {
    await seed('pay_not_mine');
    const stranger = {
      Authorization: `Bearer ${signToken({ uid: 'stranger', role: 'passenger' })}`,
    };
    getPiPayment.mockResolvedValue(piRecordFor('pay_not_mine'));

    const res = await request(app)
      .post('/api/payments/pay_not_mine/approve')
      .set(stranger)
      .send({ piPaymentId: 'pi_anything' });

    expect(res.status).toBe(403);
    expect(getPiPayment).not.toHaveBeenCalled();
  });
});
