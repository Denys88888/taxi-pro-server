import type { Request, Response } from 'express';
import { store } from '../models';
import {
  approvePayment as piApprove,
  completePayment as piComplete,
} from '../services/piService';
import { genId, nowIso } from '../utils/helpers';
import { logger } from '../utils/logger';
import type { Payment } from '../types';

// POST /api/payments — create a payment record for a ride (before Pi.createPayment).
export async function createPayment(req: Request, res: Response): Promise<void> {
  const { rideId } = req.body as { rideId: string };
  const ride = await store().getRide(rideId);
  if (!ride) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }
  if (ride.passengerId !== req.user!.uid) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const payment: Payment = {
    id: genId('pay'),
    rideId,
    amount: ride.fare,
    platformFeePercent: ride.platformFeePercent,
    platformFee: ride.platformFee,
    driverEarnings: ride.driverEarnings,
    status: 'created',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store().savePayment(payment);
  res.status(201).json({
    paymentId: payment.id,
    amount: payment.amount,
    memo: `Taxi Pro ride ${rideId}`,
    metadata: { paymentId: payment.id, rideId },
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
export async function approvePayment(req: Request, res: Response): Promise<void> {
  const { piPaymentId } = req.body as { piPaymentId: string };
  const payment = await store().getPayment(req.params.id);
  if (!payment) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  const result = await piApprove(piPaymentId);
  await store().updatePayment(payment.id, {
    piPaymentId,
    status: result.ok ? 'approved' : 'failed',
  });
  logger.info('[Payment] approve', { paymentId: payment.id, ok: result.ok });
  res.status(result.ok ? 200 : 502).json({ success: result.ok, status: result.status });
}

// POST /api/payments/:id/complete — forward completion (with txid) to Pi, finalize ride.
export async function completePayment(req: Request, res: Response): Promise<void> {
  const { piPaymentId, txid } = req.body as { piPaymentId: string; txid: string };
  const payment = await store().getPayment(req.params.id);
  if (!payment) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  const result = await piComplete(piPaymentId, txid);
  await store().updatePayment(payment.id, {
    piPaymentId,
    txid,
    status: result.ok ? 'completed' : 'failed',
  });
  if (result.ok) {
    await store().updateRide(payment.rideId, { paymentId: payment.id, txid });
  }
  logger.info('[Payment] complete', { paymentId: payment.id, ok: result.ok });
  res.status(result.ok ? 200 : 502).json({ success: result.ok, txid, status: result.status });
}
