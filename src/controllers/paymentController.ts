import type { Request, Response } from 'express';
import { store } from '../models';
import {
  approvePayment as piApprove,
  completePayment as piComplete,
  cancelPayment as piCancel,
  getPiPayment,
  payoutToUser,
} from '../services/piService';
import { env } from '../config/env';
import { sendToUser } from '../websocket/broadcast';
import { genId, nowIso, round } from '../utils/helpers';
import { logger } from '../utils/logger';
import type { Payment, Ride } from '../types';

// Payouts currently in-flight this process, keyed `${rideId}:${kind}`. The
// DB check-then-set in payoutDriver has an await between the read and the
// write, so two concurrent completePayment calls (Pi SDK firing its
// completion callback twice, a double-tap that slips the client guard) could
// both read "not yet paid" and both launch an A2U transfer. This synchronous
// set is claimed with no await in between, closing that window within the
// process (the common case on a single Render instance); Pi's own
// "ongoing_payment_found" rejection remains the cross-process backstop.
const payoutsInFlight = new Set<string>();

// POST /api/payments — create a payment record before Pi.createPayment.
// type 'ride' (default): the fare, escrowed (pending → held → completed).
// type 'tip': a voluntary post-ride tip to the driver (requires amount).
export async function createPayment(req: Request, res: Response): Promise<void> {
  const { rideId, type = 'ride', amount } = req.body as {
    rideId: string;
    type?: 'ride' | 'tip';
    amount?: number;
  };
  const ride = await store().getRide(rideId);
  if (!ride) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }
  if (ride.passengerId !== req.user!.uid) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  // Ride-level guard — checked before payment records to catch cases where
  // piComplete timed out (status saved as 'failed') but Pi actually completed
  // the transfer (txid exists on the ride). Without this, the passenger could
  // trigger a second Pi deduction on a ride that was already paid.
  if (type !== 'tip' && (ride.paymentStatus === 'completed' || ride.txid)) {
    res.status(409).json({ error: 'Payment already completed' });
    return;
  }

  if (type !== 'tip' && ride.paymentId) {
    const existing = await store().getPayment(ride.paymentId);
    if (existing && existing.status === 'approved') {
      // The fare was held (Pi escrow) but our completion call never landed —
      // the passenger's wallet was interrupted mid-flow (app killed, connection
      // dropped, Pi Browser backgrounded). Nothing else can ever unstick this
      // ride, so recover the stale hold instead of permanently blocking with
      // "payment already in progress".
      await recoverStalePayment(existing);
      const refreshedRide = await store().getRide(rideId);
      if (refreshedRide?.txid) {
        // Pi's side had actually completed — the ride is already paid, so
        // creating a new payment on top of it would double-charge. Report
        // the true state instead.
        res.status(409).json({ error: 'Payment already completed' });
        return;
      }
    } else if (existing && existing.status === 'completed') {
      res.status(409).json({ error: 'Payment already completed' });
      return;
    } else if (existing && existing.status !== 'created' && !['failed', 'cancelled'].includes(existing.status)) {
      res.status(409).json({ error: 'Payment already in progress' });
      return;
    }
    // A payment record in 'created' means our backend made it but the client
    // never got as far as opening the Pi payment sheet (app closed, network
    // drop, or — as seen in practice — a stale PWA bundle whose retry loop
    // kept hitting this exact 409 forever). Nothing on Pi's side was ever
    // touched for it (no escrow hold, nothing to double-charge), so it's
    // safe to just let a fresh attempt through instead of blocking forever.
  }
  if (type !== 'tip' && !['assigned', 'arrived', 'in_progress', 'completed'].includes(ride.status)) {
    res.status(409).json({ error: 'Ride not ready for payment' });
    return;
  }
  if (type === 'tip') {
    if (ride.status !== 'completed' || !ride.driverId) {
      res.status(409).json({ error: 'Tips are only possible after a completed ride' });
      return;
    }
    if (!amount || amount <= 0 || amount > 100) {
      res.status(400).json({ error: 'Tip amount must be between 0 and 100 π' });
      return;
    }
  }
  const isTip = type === 'tip';
  const payAmount = isTip ? round(amount!) : ride.fare;
  const payment: Payment = {
    id: genId('pay'),
    rideId,
    type,
    amount: payAmount,
    platformFeePercent: isTip ? 0 : ride.platformFeePercent,
    platformFee: isTip ? 0 : ride.platformFee,
    // Tips go to the driver in full — no platform fee.
    driverEarnings: isTip ? payAmount : ride.driverEarnings,
    status: 'created',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store().savePayment(payment);
  // Link the fare payment to the ride up front so cancellation can release it.
  if (!isTip) await store().updateRide(rideId, { paymentId: payment.id });
  res.status(201).json({
    paymentId: payment.id,
    amount: payment.amount,
    memo: isTip ? `Taxi Pro tip, ride ${rideId}` : `Taxi Pro ride ${rideId}`,
    metadata: { paymentId: payment.id, rideId, type },
  });
}

// GET /api/payments/:id — payment status.
export async function getPayment(req: Request, res: Response): Promise<void> {
  const payment = await store().getPayment(req.params.id);
  if (!payment) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  res.json(payment);
}

// POST /api/payments/:id/cancel — cancel a Pi payment the passenger left
// incomplete WITHOUT a txid (created/approved but never submitted to chain,
// e.g. they backed out of the sheet). The Pi SDK surfaces such a payment via
// onIncompletePaymentFound and will keep blocking new createPayment calls
// until it's resolved — completion is impossible (no txid), so cancel is the
// only way to unstick the user.
export async function cancelIncompletePayment(req: Request, res: Response): Promise<void> {
  const { piPaymentId } = req.body as { piPaymentId: string };
  const payment = await store().getPayment(req.params.id);
  if (!payment) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  const ride = await store().getRide(payment.rideId);
  if (ride && ride.passengerId !== req.user!.uid) {
    res.status(403).json({ error: 'Not the ride passenger' });
    return;
  }
  // Never cancel a payment we've already finalized — that would be a real
  // captured transfer, not an abandoned sheet.
  if (payment.status === 'completed') {
    res.status(409).json({ error: 'Payment already completed' });
    return;
  }
  const result = await piCancel(piPaymentId);
  await store().updatePayment(payment.id, { status: 'cancelled' });
  // A cancelled fare payment must leave the ride re-payable, not stuck.
  if (payment.type !== 'tip' && ride) {
    await store().updateRide(payment.rideId, { paymentStatus: 'pending' });
  }
  logger.info('[Payment] cancelled incomplete', { paymentId: payment.id, ok: result.ok });
  res.status(result.ok ? 200 : 502).json({ success: result.ok, status: result.status });
}

// POST /api/payments/cancel-unknown-pi — cancel a Pi payment whose metadata
// lacks our internal paymentId (old SDK version, test payment, or metadata
// corruption). Without this the Pi SDK keeps surfacing it in
// onIncompletePaymentFound and blocks all future Pi.createPayment calls.
export async function cancelUnknownPiPayment(req: Request, res: Response): Promise<void> {
  const { piPaymentId } = req.body as { piPaymentId: string };
  const result = await piCancel(piPaymentId);
  logger.info('[Payment] cancelled unknown Pi payment', { piPaymentId, ok: result.ok });
  // Return success even if Pi's cancel failed (e.g. already cancelled) — the
  // goal is just to unblock the SDK, not to guarantee a round-trip.
  res.status(200).json({ success: true, piStatus: result.status });
}

// POST /api/payments/:id/approve — forward approval to the Pi Platform API.
// For the fare this is the escrow "hold": Pi has reserved the funds but we
// have not completed the transfer yet.
export async function approvePayment(req: Request, res: Response): Promise<void> {
  const { piPaymentId } = req.body as { piPaymentId: string };
  const payment = await store().getPayment(req.params.id);
  if (!payment) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  const ride = await store().getRide(payment.rideId);
  if (ride && ride.passengerId !== req.user!.uid) {
    res.status(403).json({ error: 'Not the ride passenger' });
    return;
  }
  // Idempotency: a retried approval must not overwrite a completed payment.
  if (payment.status === 'completed') {
    res.status(200).json({ success: true, status: 'already_completed' });
    return;
  }
  // Same piPaymentId already approved — safe to return success immediately.
  if (payment.status === 'approved' && payment.piPaymentId === piPaymentId) {
    res.status(200).json({ success: true, status: 'already_approved' });
    return;
  }
  const result = await piApprove(piPaymentId);
  await store().updatePayment(payment.id, {
    piPaymentId,
    status: result.ok ? 'approved' : 'failed',
  });
  if (result.ok && payment.type !== 'tip') {
    await store().updateRide(payment.rideId, { paymentStatus: 'held' });
  }
  logger.info('[Payment] approve', { paymentId: payment.id, type: payment.type, ok: result.ok });
  res.status(result.ok ? 200 : 502).json({ success: result.ok, status: result.status });
}

// POST /api/payments/:id/complete — forward completion (with txid) to Pi,
// then finalize the ride (fare → paymentStatus completed; tip → tipAmount).
export async function completePayment(req: Request, res: Response): Promise<void> {
  const { piPaymentId, txid } = req.body as { piPaymentId: string; txid: string };
  const payment = await store().getPayment(req.params.id);
  if (!payment) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  const rideCheck = await store().getRide(payment.rideId);
  if (rideCheck && rideCheck.passengerId !== req.user!.uid) {
    res.status(403).json({ error: 'Not the ride passenger' });
    return;
  }
  // Idempotency: a retried/duplicated complete must not run twice — otherwise a
  // tip would be credited to the driver more than once.
  if (payment.status === 'completed') {
    res.status(200).json({ success: true, txid: payment.txid ?? txid, status: 'already_completed' });
    return;
  }
  const result = await piComplete(piPaymentId, txid);
  await store().updatePayment(payment.id, {
    piPaymentId,
    txid,
    status: result.ok ? 'completed' : 'failed',
  });
  if (result.ok) {
    const ride = await store().getRide(payment.rideId);
    if (payment.type === 'tip') {
      const updated = await store().updateRide(payment.rideId, {
        tipAmount: round((ride?.tipAmount ?? 0) + payment.amount),
        tipTxid: txid,
      });
      if (updated?.driverId) {
        sendToUser(updated.driverId, {
          type: 'ride_status_update',
          rideId: updated.id,
          status: 'tip_received',
          data: { tipAmount: payment.amount },
        });
        void payoutDriver(updated, 'tip', payment.amount);
      }
    } else {
      const updated = await store().updateRide(payment.rideId, {
        paymentId: payment.id,
        txid,
        paymentStatus: 'completed',
      });
      if (updated?.driverId) {
        sendToUser(updated.driverId, {
          type: 'ride_status_update',
          rideId: updated.id,
          status: 'payment_received',
          data: { amount: updated.driverEarnings },
        });
        void payoutDriver(updated, 'fare', updated.driverEarnings);
      }
    }
  }
  logger.info('[Payment] complete', { paymentId: payment.id, type: payment.type, ok: result.ok });
  res.status(result.ok ? 200 : 502).json({ success: result.ok, txid, status: result.status });
}

// Send the driver their real share of a fare or tip out of the app's Pi
// wallet (App-to-User). Runs after the response to the passenger has already
// been sent — the passenger's payment is complete regardless of payout
// outcome, so this never blocks or fails their request. Without
// PI_WALLET_SEED configured, this silently no-ops (logged once at startup);
// funds simply stay queued as 'pending' until an operator backfills them.
export async function payoutDriver(ride: Ride, kind: 'fare' | 'tip', amount: number): Promise<void> {
  if (!ride.driverId || amount <= 0) return;
  const statusField = kind === 'fare' ? 'driverPayoutStatus' : 'tipPayoutStatus';
  if (!env.PI_WALLET_SEED) {
    await store().updateRide(ride.id, { [statusField]: 'no_wallet_configured' });
    logger.warn('[Payout] PI_WALLET_SEED not set — ride queued for manual payout', {
      rideId: ride.id, driverId: ride.driverId, kind, amount,
    });
    return;
  }
  const txidField = kind === 'fare' ? 'driverPayoutTxid' : 'tipPayoutTxid';
  // Synchronously claim this (rideId, kind) before any await — two concurrent
  // callers can't both pass has()→add() since there's no yield point between
  // them, so only the first proceeds to the DB check + Pi transfer below.
  const claimKey = `${ride.id}:${kind}`;
  if (payoutsInFlight.has(claimKey)) {
    logger.warn('[Payout] skipped concurrent payout attempt', { rideId: ride.id, kind });
    return;
  }
  payoutsInFlight.add(claimKey);
  try {
    // Second line of defence across process restarts / prior completed
    // payouts: our own persisted record. (Pi's "ongoing_payment_found" is
    // the cross-process backstop for the rare multi-instance case.)
    const fresh = await store().getRide(ride.id);
    if (fresh?.[statusField] === 'pending' || fresh?.[statusField] === 'completed') {
      logger.warn('[Payout] skipped duplicate payout attempt', { rideId: ride.id, kind, status: fresh[statusField] });
      return;
    }
    await store().updateRide(ride.id, { [statusField]: 'pending' });
    try {
      const { txid } = await payoutToUser(
        ride.driverId,
        amount,
        `Taxi Pro ${kind} payout, ride ${ride.id}`,
        { rideId: ride.id, kind }
      );
      await store().updateRide(ride.id, { [statusField]: 'completed', [txidField]: txid });
      logger.info('[Payout] driver paid', { rideId: ride.id, driverId: ride.driverId, kind, amount, txid });
    } catch (err) {
      const txidFromPartialFailure = (err as { txid?: string }).txid;
      const piPaymentIdFromFailure = (err as { piPaymentId?: string }).piPaymentId;
      const errorField = kind === 'fare' ? 'driverPayoutError' : 'tipPayoutError';
      const piIdField = kind === 'fare' ? 'driverPayoutPiId' : 'tipPayoutPiId';
      await store().updateRide(ride.id, {
        [statusField]: 'failed',
        [errorField]: (err as Error).message,
        ...(txidFromPartialFailure ? { [txidField]: txidFromPartialFailure } : {}),
        ...(piPaymentIdFromFailure ? { [piIdField]: piPaymentIdFromFailure } : {}),
      });
      logger.error('[Payout] driver payout failed', {
        rideId: ride.id,
        driverId: ride.driverId,
        kind,
        amount,
        error: (err as Error).message,
      });
    }
  } finally {
    payoutsInFlight.delete(claimKey);
  }
}

// A held (approved) fare payment whose completion never landed on our side —
// the passenger's wallet may have actually finished the transfer before the
// interruption (app killed, dropped connection) hit. Ask Pi for the real
// state before touching anything: cancelling a payment Pi already completed
// would incorrectly leave the ride unpaid while the passenger's Pi was
// captured, and creating a fresh payment on top would double-charge them.
export async function recoverStalePayment(payment: Payment): Promise<void> {
  if (!payment.piPaymentId) {
    await releaseHeldPayment(payment.id);
    return;
  }
  try {
    const { data } = await getPiPayment<{ transaction?: { txid?: string } | null }>(
      payment.piPaymentId
    );
    const txid = data.transaction?.txid;
    if (txid) {
      // Pi confirms it went through — finalize on our side exactly like a
      // normal completion would, instead of discarding a real payment.
      await store().updatePayment(payment.id, { txid, status: 'completed' });
      const updated = await store().updateRide(payment.rideId, {
        paymentId: payment.id,
        txid,
        paymentStatus: 'completed',
      });
      if (updated?.driverId) {
        sendToUser(updated.driverId, {
          type: 'ride_status_update',
          rideId: updated.id,
          status: 'payment_received',
          data: { amount: updated.driverEarnings },
        });
        void payoutDriver(updated, 'fare', updated.driverEarnings);
      }
      logger.info('[Payment] recovered as completed', { paymentId: payment.id });
      return;
    }
  } catch (err) {
    logger.warn('[Payment] recovery status check failed', {
      paymentId: payment.id,
      error: (err as Error).message,
    });
  }
  await releaseHeldPayment(payment.id);
  await store().updateRide(payment.rideId, { paymentStatus: 'pending' });
}

// Release a held fare payment back to the passenger (ride cancelled). Failures
// are logged, not thrown — cancellation must succeed even if Pi is unreachable.
export async function releaseHeldPayment(paymentId: string): Promise<void> {
  try {
    const payment = await store().getPayment(paymentId);
    if (!payment || payment.status !== 'approved') return;
    if (payment.piPaymentId) await piCancel(payment.piPaymentId);
    await store().updatePayment(paymentId, { status: 'cancelled' });
  } catch (err) {
    logger.warn('[Payment] release failed', { paymentId, error: (err as Error).message });
  }
}
