import type { Request, Response } from 'express';
import { store } from '../models';
import { calculateFare, estimateDurationMin } from '../services/fareCalculator';
import { haversineKm, genId, nowIso, round } from '../utils/helpers';
import { signShareToken } from '../utils/jwt';
import { LATE_CANCELLATION_FEE_PERCENT } from '../config/constants';
import { sendToUser, broadcast } from '../websocket/broadcast';
import type { Ride, GeoPoint, VehicleType, RideStatus } from '../types';

// POST /api/rides — create a ride request (server computes distance + fare).
export async function createRide(req: Request, res: Response): Promise<void> {
  const { pickup, destination, vehicleType } = req.body as {
    pickup: GeoPoint;
    destination: GeoPoint;
    vehicleType: VehicleType;
  };
  const settings = await store().getSettings();
  const distanceKm = round(
    haversineKm(pickup.lat, pickup.lng, destination.lat, destination.lng)
  );
  const durationMin = estimateDurationMin(distanceKm);
  const breakdown = calculateFare({
    vehicleType,
    distanceKm,
    durationMin,
    platformFeePercent: settings.platformFeePercent,
  });
  const ride: Ride = {
    id: genId('ride'),
    passengerId: req.user!.uid,
    pickup,
    destination,
    vehicleType,
    distanceKm,
    estimatedDurationMin: durationMin,
    ...breakdown,
    status: 'searching',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store().saveRide(ride);
  broadcast({ type: 'ride_available', ride }, 'driver');
  res.status(201).json(ride);
}

// GET /api/rides?status=&page=&limit= — the caller's rides.
export async function listRides(req: Request, res: Response): Promise<void> {
  const status = req.query.status as RideStatus | undefined;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const result = await store().listRidesByUser(req.user!.uid, status, page, limit);
  res.json(result);
}

// GET /api/rides/:id — ride details (participants only).
export async function getRide(req: Request, res: Response): Promise<void> {
  const ride = await store().getRide(req.params.id);
  if (!ride) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }
  const uid = req.user!.uid;
  if (ride.passengerId !== uid && ride.driverId !== uid && req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  res.json(ride);
}

// PATCH /api/rides/:id — update status / ratings (participants only).
export async function updateRide(req: Request, res: Response): Promise<void> {
  const ride = await store().getRide(req.params.id);
  if (!ride) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }
  const uid = req.user!.uid;
  if (ride.passengerId !== uid && ride.driverId !== uid) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const allowed = [
    'status',
    'passengerRating',
    'driverRating',
    'passengerReview',
    'driverReview',
    'txid',
    'paymentId',
  ] as const;
  const patch: Partial<Ride> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) (patch as Record<string, unknown>)[key] = req.body[key];
  }
  const updated = await store().updateRide(req.params.id, patch);
  if (patch.status) {
    const payload = { type: 'ride_status_update', rideId: ride.id, status: patch.status, data: {} };
    sendToUser(ride.passengerId, payload);
    if (ride.driverId) sendToUser(ride.driverId, payload);
  }
  // If a rating was submitted for a user, fold it into their running average.
  if (patch.driverRating && ride.driverId) await applyRating(ride.driverId, patch.driverRating);
  if (patch.passengerRating) await applyRating(ride.passengerId, patch.passengerRating);
  res.json(updated);
}

async function applyRating(uid: string, score: number): Promise<void> {
  const user = await store().getUser(uid);
  if (!user) return;
  const count = user.ratingCount + 1;
  const rating = round((user.rating * user.ratingCount + score) / count, 2);
  await store().updateUser(uid, { rating, ratingCount: count });
}

// POST /api/rides/:id/cancel — cancel with a reason (fee applies after arrival).
export async function cancelRide(req: Request, res: Response): Promise<void> {
  const ride = await store().getRide(req.params.id);
  if (!ride) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }
  const uid = req.user!.uid;
  if (ride.passengerId !== uid && ride.driverId !== uid) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (['completed', 'cancelled'].includes(ride.status)) {
    res.status(409).json({ error: `Ride already ${ride.status}` });
    return;
  }
  // Free before the driver arrives; percentage fee afterwards.
  const feeApplies = ride.status === 'arrived' || ride.status === 'in_progress';
  const cancellationFee = feeApplies
    ? round((ride.fare * LATE_CANCELLATION_FEE_PERCENT) / 100)
    : 0;
  const updated = await store().updateRide(req.params.id, {
    status: 'cancelled',
    cancelledBy: req.user!.role,
    cancellationReason: String(req.body.reason),
    cancellationFee,
  });
  const payload = {
    type: 'ride_status_update',
    rideId: ride.id,
    status: 'cancelled',
    data: { cancellationFee, reason: req.body.reason },
  };
  sendToUser(ride.passengerId, payload);
  if (ride.driverId) sendToUser(ride.driverId, payload);
  res.json(updated);
}

// POST /api/rides/:id/share — issue a short-lived read-only share token.
export async function shareRide(req: Request, res: Response): Promise<void> {
  const ride = await store().getRide(req.params.id);
  if (!ride || ride.passengerId !== req.user!.uid) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }
  const shareToken = signShareToken(ride.id);
  await store().updateRide(ride.id, { shareToken });
  res.json({ shareToken });
}
