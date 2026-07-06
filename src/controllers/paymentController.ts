import type { Request, Response } from 'express';
import { store } from '../models';
import {
  approvePayment as piApprove,
  completePayment as piComplete,
  cancelPayment as piCancel,
} from '../services/piService';
import { sendToUser } from '../websocket/broadcast';
import { genId, nowIso, round } from '../utils/helpers';
import { logger } from '../utils/logger';
import type { Payment } from '../types';

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
  if (type !== 'tip' && ride.paymentId) {
    const existing = await store().getPayment(ride.paymentId);
    if (existing && !['failed', 'cancelled'].includes(existing.status)) {
      res.status(409).json({ error: 'Payment already in progress' });
      return;
    }
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
      }
    } else {
      await store().updateRide(payment.rideId, {
        paymentId: payment.id,
        txid,
        paymentStatus: 'completed',
      });
    }
  }
  logger.info('[Payment] complete', { paymentId: payment.id, type: payment.type, ok: result.ok });
  res.status(result.ok ? 200 : 502).json({ success: result.ok, txid, status: result.status });
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
