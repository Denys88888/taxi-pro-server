import request from 'supertest';

// The server half of onIncompletePaymentFound. The Pi SDK hands the frontend a
// payment left open by an interrupted session; resolveIncompletePayment then
// drives exactly these endpoints — complete when Pi has a txid, cancel when it
// does not, cancel-unknown-pi when our id is missing from the metadata.
//
// Nothing here creates a real payment: every Pi call is mocked, so this runs on
// its own against the in-memory store. It is the safe rehearsal for the Sandbox
// walkthrough at the bottom of this file.
const getPiPayment = jest.fn();
const completePayment = jest.fn();
const cancelPayment = jest.fn();
const payoutToUser = jest.fn();

jest.mock('../src/services/piService', () => ({
  getPiPayment: (...args: unknown[]) => getPiPayment(...args),
  completePayment: (...args: unknown[]) => completePayment(...args),
  cancelPayment: (...args: unknown[]) => cancelPayment(...args),
  approvePayment: jest.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
  payoutToUser: (...args: unknown[]) => payoutToUser(...args),
  verifyPiAccessToken: jest.fn(),
}));

import { createApp } from '../src/app';
import { signToken } from '../src/utils/jwt';
import { store } from '../src/models';
import type { Payment, Ride } from '../src/types';

const app = createApp();

const PASSENGER = 'passenger_recovery';
const DRIVER = 'driver_recovery';
const auth = { Authorization: `Bearer ${signToken({ uid: PASSENGER, role: 'passenger' })}` };

const nowIso = new Date().toISOString();

async function seedHeldFare(paymentId: string, piPaymentId: string): Promise<string> {
  const rideId = `ride_${paymentId}`;
  await store().saveRide({
    id: rideId,
    passengerId: PASSENGER,
    driverId: DRIVER,
    status: 'completed',
    pickup: { lat: 0, lng: 0 },
    destination: { lat: 1, lng: 1 },
    distanceKm: 4,
    estimatedDurationMin: 12,
    fare: 20,
    platformFeePercent: 10,
    platformFee: 2,
    driverEarnings: 18,
    paymentStatus: 'held',
    paymentId,
    createdAt: nowIso,
    updatedAt: nowIso,
  } as unknown as Ride);
  await store().savePayment({
    id: paymentId,
    rideId,
    type: 'ride',
    amount: 20,
    platformFeePercent: 10,
    platformFee: 2,
    driverEarnings: 18,
    status: 'approved',
    piPaymentId,
    createdAt: nowIso,
    updatedAt: nowIso,
  } as Payment);
  return rideId;
}

// Payouts are fire-and-forget by contract (`void payoutDriver(...)`), so give
// the microtask queue a turn before asserting on them.
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  completePayment.mockResolvedValue({ ok: true, status: 200, data: {} });
  cancelPayment.mockResolvedValue({ ok: true, status: 200, data: {} });
  payoutToUser.mockResolvedValue({ txid: 'tx_driver_payout' });
});

describe('an interrupted payment that Pi did complete', () => {
  it('recovers it, and a repeated callback does not pay the driver twice', async () => {
    const rideId = await seedHeldFare('pay_rec_a', 'pi_rec_a');
    getPiPayment.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        user_uid: PASSENGER,
        metadata: { paymentId: 'pay_rec_a' },
        transaction: { txid: 'tx_chain_a' },
      },
    });

    // First callback: the SDK reports the leftover, the frontend completes it.
    const first = await request(app)
      .post('/api/payments/pay_rec_a/complete')
      .set(auth)
      .send({ piPaymentId: 'pi_rec_a', txid: 'tx_chain_a' });
    await settle();

    expect(first.status).toBe(200);
    expect(completePayment).toHaveBeenCalledTimes(1);
    const afterFirst = await store().getRide(rideId);
    expect(afterFirst?.paymentStatus).toBe('completed');
    expect(afterFirst?.txid).toBe('tx_chain_a');
    // The payout path was entered exactly once. There is no PI_WALLET_SEED in
    // tests, so it stops before the wallet and parks at 'no_wallet_configured'
    // — that field is the evidence the payout ran, not payoutToUser itself.
    // (Duplicate-payout protection proper lives in payoutSafety.test.ts.)
    expect(afterFirst?.driverPayoutStatus).toBe('no_wallet_configured');
    expect(payoutToUser).not.toHaveBeenCalled();

    // Second callback: the SDK fires onIncompletePaymentFound again — a fresh
    // page load re-arms it before our own state has caught up.
    const second = await request(app)
      .post('/api/payments/pay_rec_a/complete')
      .set(auth)
      .send({ piPaymentId: 'pi_rec_a', txid: 'tx_chain_a' });
    await settle();

    expect(second.status).toBe(200);
    expect(second.body.status).toBe('already_completed');
    // Never re-entered: not Pi, not the payout, not the ride record.
    expect(completePayment).toHaveBeenCalledTimes(1);
    const afterSecond = await store().getRide(rideId);
    expect(afterSecond?.txid).toBe('tx_chain_a');
    expect(afterSecond?.driverPayoutStatus).toBe('no_wallet_configured');
    expect(afterSecond?.driverPayoutTxid).toBeUndefined();
  });
});

describe('an interrupted payment that never reached the chain', () => {
  it('cancels it and leaves the ride payable again', async () => {
    const rideId = await seedHeldFare('pay_rec_b', 'pi_rec_b');
    getPiPayment.mockResolvedValue({
      ok: true,
      status: 200,
      data: { user_uid: PASSENGER, metadata: { paymentId: 'pay_rec_b' }, transaction: null },
    });

    const res = await request(app)
      .post('/api/payments/pay_rec_b/cancel')
      .set(auth)
      .send({ piPaymentId: 'pi_rec_b' });

    expect(res.status).toBe(200);
    expect(cancelPayment).toHaveBeenCalledWith('pi_rec_b');
    expect((await store().getPayment('pay_rec_b'))?.status).toBe('cancelled');
    expect((await store().getRide(rideId))?.paymentStatus).toBe('pending');
    expect(payoutToUser).not.toHaveBeenCalled();
  });
});

describe('a leftover that is not this record’s', () => {
  it('is refused rather than resolved against the wrong payment', async () => {
    await seedHeldFare('pay_rec_c', 'pi_rec_c');

    // The SDK surfaced some other payment; the frontend must not be able to
    // settle it through a record that happens to belong to the caller.
    const res = await request(app)
      .post('/api/payments/pay_rec_c/complete')
      .set(auth)
      .send({ piPaymentId: 'pi_a_stranger', txid: 'tx_stranger' });
    await settle();

    expect(res.status).toBe(409);
    expect(completePayment).not.toHaveBeenCalled();
    expect(payoutToUser).not.toHaveBeenCalled();
  });
});

// ── Sandbox / Testnet walkthrough ──────────────────────────────────────────
//
// The scenario above with real Pi calls. Run it by hand, in Sandbox or Testnet,
// with a throwaway account and a minimum fare — never against production, and
// never with an account that has real balance worth losing.
//
//   1. Start a ride and tap Pay. When the Pi sheet opens, confirm it, then kill
//      the app before the completion callback lands. That leaves the payment
//      approved on Pi with our record still 'approved' — the exact state
//      onIncompletePaymentFound exists for.
//   2. Reopen the app. The SDK reports the leftover and the frontend resolves
//      it. Expect: ride paymentStatus 'completed', one `[Payment] pi call`
//      log line with operation 'complete' and ok true.
//   3. Reload again to fire the callback a second time. Expect: HTTP 200 with
//      status 'already_completed', no second `[Payment] pi call`, and the
//      driver's payout txid unchanged.
//   4. Repeat step 1 but dismiss the sheet instead of confirming. Expect the
//      cancel path: payment 'cancelled', ride payable again, no payout.
//   5. Binding, by hand: with the leftover still open, call
//      POST /api/payments/<your own other payment id>/complete carrying that
//      leftover's piPaymentId. Expect 409 and a `[Payment] binding refused`
//      line with reason 'pi_metadata_mismatch' — no Pi call, no payout.
