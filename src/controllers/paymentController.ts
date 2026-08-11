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
// type 'fee': a late-cancellation fee already recorded on a cancelled ride.
export async function createPayment(req: Request, res: Response): Promise<void> {
  const { rideId, type = 'ride', amount } = req.body as {
    rideId: string;
    type?: 'ride' | 'tip' | 'fee';
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
  // Everything below the fare guards applies only to the fare itself. A tip and
  // a cancellation fee are separate Pi transactions with their own rules — they
  // are not the escrowed fare and must not be blocked by its state.
  const isFare = type === 'ride';
  // Ride-level guard — checked before payment records to catch cases where
  // piComplete timed out (status saved as 'failed') but Pi actually completed
  // the transfer (txid exists on the ride). Without this, the passenger could
  // trigger a second Pi deduction on a ride that was already paid.
  if (isFare && (ride.paymentStatus === 'completed' || ride.txid)) {
    res.status(409).json({ error: 'Payment already completed' });
    return;
  }

  if (isFare && ride.paymentId) {
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
  if (isFare && !['assigned', 'arrived', 'in_progress', 'completed'].includes(ride.status)) {
    res.status(409).json({ error: 'Ride not ready for payment' });
    return;
  }
  const isTip = type === 'tip';
  if (isTip) {
    if (ride.status !== 'completed' || !ride.driverId) {
      res.status(409).json({ error: 'Tips are only possible after a completed ride' });
      return;
    }
    if (!amount || amount <= 0 || amount > 100) {
      res.status(400).json({ error: 'Tip amount must be between 0 and 100 π' });
      return;
    }
  }
  const isFee = type === 'fee';
  if (isFee) {
    // The amount is whatever cancelRide worked out and wrote down. It is never
    // read from the request: the client already knows the figure, and letting
    // it name its own would let a passenger settle a 3 π debt for 0.01 π.
    if (ride.cancellationFeeStatus !== 'outstanding' || !(ride.cancellationFee! > 0)) {
      res.status(409).json({ error: 'No cancellation fee is outstanding on this ride' });
      return;
    }
    if (!ride.driverId) {
      res.status(409).json({ error: 'Cancellation fee has no driver to pay' });
      return;
    }
    if (ride.cancellationFeePaymentId) {
      // An earlier attempt at the same debt. 'created' means our record was
      // written but the wallet sheet never opened (app closed, no `payments`
      // scope, connection dropped) — nothing exists on Pi's side, so a fresh
      // attempt is safe. Anything further along means Pi may already be
      // holding the passenger's money for this fee, and opening a second
      // sheet would take it twice, so find out what really happened first.
      const existing = await store().getPayment(ride.cancellationFeePaymentId);
      if (existing && ['approved', 'completed'].includes(existing.status)) {
        await recoverStaleFeePayment(existing);
        const refreshed = await store().getRide(rideId);
        if (refreshed?.cancellationFeeStatus !== 'outstanding') {
          res.status(409).json({ error: 'Cancellation fee already paid' });
          return;
        }
      }
    }
  }
  // A cancellation fee is split like the fare it replaces, not like a tip: the
  // driver is being compensated for work, not handed a gratuity.
  const feePlatformFee = isFee ? round((ride.cancellationFee! * ride.platformFeePercent) / 100) : 0;
  const payAmount = isTip ? round(amount!) : isFee ? ride.cancellationFee! : ride.fare;
  const payment: Payment = {
    id: genId('pay'),
    rideId,
    type,
    amount: payAmount,
    platformFeePercent: isTip ? 0 : ride.platformFeePercent,
    platformFee: isTip ? 0 : isFee ? feePlatformFee : ride.platformFee,
    // Tips go to the driver in full — no platform fee.
    driverEarnings: isTip ? payAmount : isFee ? round(payAmount - feePlatformFee) : ride.driverEarnings,
    status: 'created',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store().savePayment(payment);
  // Link the fare payment to the ride up front so cancellation can release it.
  if (isFare) await store().updateRide(rideId, { paymentId: payment.id });
  if (isFee) await store().updateRide(rideId, { cancellationFeePaymentId: payment.id });
  res.status(201).json({
    paymentId: payment.id,
    amount: payment.amount,
    memo: isTip
      ? `Taxi Pro tip, ride ${rideId}`
      : isFee
        ? `Taxi Pro cancellation fee, ride ${rideId}`
        : `Taxi Pro ride ${rideId}`,
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
  // This had no authorization at all: any authenticated user could read any
  // payment record — amount, platform fee, driver earnings, txid, the Pi
  // payment id — given its id. Ids carry only 32 bits of randomness on top of
  // a guessable timestamp, so the rate limiter was the only thing standing in
  // the way. Restricted to the ride's two participants, matching getRide,
  // which already exposes the same figures to exactly those two.
  const ride = await store().getRide(payment.rideId);
  const uid = req.user!.uid;
  if (!ride || (ride.passengerId !== uid && ride.driverId !== uid)) {
    res.status(403).json({ error: 'Forbidden' });
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
  // `ride &&` here skipped the whole check when the lookup missed, the same
  // short-circuit that left chat history readable — deny instead.
  if (!ride || ride.passengerId !== req.user!.uid) {
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
  // Ownership check — without this any authenticated user could cancel any
  // other user's in-flight Pi payment just by guessing/observing its id. Ask
  // Pi who the payment belongs to and refuse if it isn't the caller's.
  try {
    const { ok, data } = await getPiPayment<{ user_uid?: string }>(piPaymentId);
    if (!ok) {
      res.status(404).json({ error: 'Pi payment not found' });
      return;
    }
    if (data.user_uid && data.user_uid !== req.user!.uid) {
      logger.warn('[Payment] blocked cross-user cancel attempt', {
        piPaymentId, owner: data.user_uid, caller: req.user!.uid,
      });
      res.status(403).json({ error: 'Not your payment' });
      return;
    }
  } catch (err) {
    logger.warn('[Payment] ownership check failed', { piPaymentId, error: (err as Error).message });
    res.status(502).json({ error: 'Could not verify payment ownership' });
    return;
  }
  const result = await piCancel(piPaymentId);
  logger.info('[Payment] cancelled unknown Pi payment', { piPaymentId, uid: req.user!.uid, ok: result.ok });
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
  // Same short-circuit as above: a missed lookup must deny, not wave through.
  if (!ride || ride.passengerId !== req.user!.uid) {
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
  // Only the fare is escrowed. Records written before 'type' existed are fares.
  // A fee payment approved here must not touch paymentStatus — the ride is
  // cancelled and its fare was already refunded; flipping it back to 'held'
  // would show the passenger money on hold for a trip that never happened.
  if (result.ok && (payment.type ?? 'ride') === 'ride') {
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
  // Same short-circuit again, and on the call that actually moves money —
  // completing credits the tip and marks the fare paid.
  if (!rideCheck || rideCheck.passengerId !== req.user!.uid) {
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
    } else if (payment.type === 'fee') {
      await finalizeFeePayment(payment, txid);
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

// Every kind of payout keeps its own set of fields on the ride, so a fare, a
// tip and a cancellation fee for the same trip each get their own txid and
// their own duplicate protection. Kept as one table rather than a chain of
// ternaries — those quietly filed a third kind under the tip's fields, which
// would have let a paid-out fee mask an unpaid tip.
// Exported so the admin retry path reads and clears exactly the fields the
// payout wrote, instead of keeping its own copy of the mapping to drift from.
export const PAYOUT_FIELDS = {
  fare: {
    status: 'driverPayoutStatus', txid: 'driverPayoutTxid',
    error: 'driverPayoutError', piId: 'driverPayoutPiId',
  },
  tip: {
    status: 'tipPayoutStatus', txid: 'tipPayoutTxid',
    error: 'tipPayoutError', piId: 'tipPayoutPiId',
  },
  fee: {
    status: 'feePayoutStatus', txid: 'feePayoutTxid',
    error: 'feePayoutError', piId: 'feePayoutPiId',
  },
} as const;

export type PayoutKind = keyof typeof PAYOUT_FIELDS;

// Send the driver their real share of a fare, tip or cancellation fee out of
// the app's Pi wallet (App-to-User). Runs after the response to the passenger
// has already been sent — the passenger's payment is complete regardless of
// payout outcome, so this never blocks or fails their request. Without
// PI_WALLET_SEED configured, this silently no-ops (logged once at startup);
// funds simply stay queued as 'pending' until an operator backfills them.
export async function payoutDriver(ride: Ride, kind: PayoutKind, amount: number): Promise<void> {
  if (!ride.driverId || amount <= 0) return;
  const statusField = PAYOUT_FIELDS[kind].status;
  const txidField = PAYOUT_FIELDS[kind].txid;
  // Checked before anything else, including the wallet-config branch below:
  // a recorded txid means funds for this (ride, kind) already settled on chain.
  // Nothing may overwrite that record — doing so would misfile a settled payout
  // as awaiting one, and an operator acting on it would pay the driver twice.
  if (ride[txidField]) {
    logger.error('[Payout] refused — funds already transferred', {
      rideId: ride.id, kind, txid: ride[txidField], status: ride[statusField],
    });
    return;
  }
  if (!env.PI_WALLET_SEED) {
    await store().updateRide(ride.id, { [statusField]: 'no_wallet_configured' });
    logger.warn('[Payout] PI_WALLET_SEED not set — ride queued for manual payout', {
      rideId: ride.id, driverId: ride.driverId, kind, amount,
    });
    return;
  }
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
    // Hard stop on paying twice: a recorded txid means a Stellar transfer for
    // this (ride, kind) already settled, whatever the status says. This is the
    // single chokepoint every payout goes through, so it protects the admin
    // retry path and any future caller alike.
    if (fresh?.[txidField]) {
      logger.error('[Payout] refused re-send — funds already transferred', {
        rideId: ride.id, kind, txid: fresh[txidField], status: fresh[statusField],
      });
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
      const errorField = PAYOUT_FIELDS[kind].error;
      const piIdField = PAYOUT_FIELDS[kind].piId;
      // A txid on the error means the Stellar transfer already settled and only
      // Pi's bookkeeping call failed — the driver HAS the money. Recording that
      // as 'failed' would put the ride in the operator's unpaid queue, where a
      // retry would pay them a second time. 'sent_unconfirmed' says: funds are
      // gone, do not re-send, just reconcile with Pi.
      await store().updateRide(ride.id, {
        [statusField]: txidFromPartialFailure ? 'sent_unconfirmed' : 'failed',
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

// Settle a cancellation-fee payment on our side: the debt is cleared, so the
// passenger can book again, and the driver is paid their share of it the same
// way they are paid a fare. Shared by the normal completion path and by the
// recovery below, so a fee Pi captured always lands the same way whichever
// route we learn about it from.
async function finalizeFeePayment(payment: Payment, txid: string): Promise<void> {
  const updated = await store().updateRide(payment.rideId, {
    cancellationFeeStatus: 'paid',
    cancellationFeePaymentId: payment.id,
    cancellationFeeTxid: txid,
    cancellationFeeDriverEarnings: payment.driverEarnings,
  });
  if (updated?.driverId) {
    sendToUser(updated.driverId, {
      type: 'ride_status_update',
      rideId: updated.id,
      status: 'cancellation_fee_received',
      data: { amount: payment.driverEarnings },
    });
    void payoutDriver(updated, 'fee', payment.driverEarnings);
  }
}

// A cancellation-fee payment the passenger approved but whose completion never
// reached us. Same hazard as a stale fare, different resolution: a fee has no
// paymentStatus to reset — the debt is either settled or still owed — and the
// ride is already cancelled, so nothing here may touch the fare's fields.
// Ask Pi what actually happened: if it captured the fee, finish the job the
// interrupted call started; if not, drop the hold so the next attempt is free
// to open a sheet. Either way the passenger stops being stuck behind a debt
// they already tried to pay.
export async function recoverStaleFeePayment(payment: Payment): Promise<void> {
  if (payment.piPaymentId) {
    try {
      const { data } = await getPiPayment<{ transaction?: { txid?: string } | null }>(
        payment.piPaymentId
      );
      const txid = data.transaction?.txid;
      if (txid) {
        await store().updatePayment(payment.id, { txid, status: 'completed' });
        await finalizeFeePayment(payment, txid);
        logger.info('[Payment] fee recovered as completed', { paymentId: payment.id });
        return;
      }
    } catch (err) {
      logger.warn('[Payment] fee recovery status check failed', {
        paymentId: payment.id,
        error: (err as Error).message,
      });
    }
  }
  await releaseHeldPayment(payment.id);
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
