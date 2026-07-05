import type { Request, Response } from 'express';
import { store } from '../models';
import { calculateFare } from '../services/fareCalculator';
import { getRouteInfo } from '../services/routingService';
import { genId, nowIso, round } from '../utils/helpers';
import { signShareToken } from '../utils/jwt';
import { LATE_CANCELLATION_FEE_PERCENT } from '../config/constants';
import { sendToUser, broadcast } from '../websocket/broadcast';
import type { Ride, GeoPoint, VehicleType, RideStatus, RideParty } from '../types';

// POST /api/rides — create a ride request (server computes distance + fare).
// Supports multi-stop, scheduled (future dispatch) and negotiable (inDriver) rides.
export async function createRide(req: Request, res: Response): Promise<void> {
  const { pickup, destination, vehicleType, stops, scheduledAt, negotiable, offeredFare } =
    req.body as {
      pickup: GeoPoint;
      destination: GeoPoint;
      vehicleType: VehicleType;
      stops?: GeoPoint[];
      scheduledAt?: string;
      negotiable?: boolean;
      offeredFare?: number;
    };
  const settings = await store().getSettings();
  // Distance follows the full path (pickup → stops… → destination) along the
  // road network; haversine is only the offline fallback inside getRouteInfo.
  const path = [pickup, ...(stops ?? []), destination];
  const routeInfo = await getRouteInfo(path);
  const distanceKm = round(routeInfo.distanceKm);
  const durationMin = routeInfo.durationMin;
  const breakdown = calculateFare({
    vehicleType,
    distanceKm,
    durationMin,
    platformFeePercent: settings.platformFeePercent,
  });

  // A negotiable ride uses the passenger's asking price as the working fare.
  const fareBase =
    negotiable && offeredFare && offeredFare > 0
      ? { ...breakdown, fare: round(offeredFare), platformFee: round((offeredFare * breakdown.platformFeePercent) / 100), driverEarnings: round(offeredFare - (offeredFare * breakdown.platformFeePercent) / 100) }
      : breakdown;

  // Future-dated rides wait as 'scheduled'; the dispatcher promotes them when due.
  const isScheduled = !!scheduledAt && new Date(scheduledAt).getTime() > Date.now();

  const ride: Ride = {
    id: genId('ride'),
    passengerId: req.user!.uid,
    pickup,
    destination,
    ...(stops && stops.length ? { stops } : {}),
    vehicleType,
    distanceKm,
    estimatedDurationMin: durationMin,
    ...fareBase,
    status: isScheduled ? 'scheduled' : 'searching',
    ...(scheduledAt ? { scheduledAt } : {}),
    ...(negotiable ? { negotiable: true, offeredFare: round(offeredFare ?? breakdown.fare), offers: [] } : {}),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store().saveRide(ride);
  // Immediate rides are offered to drivers now; scheduled ones dispatch later.
  if (!isScheduled) broadcast({ type: 'ride_available', ride }, 'driver');
  res.status(201).json(ride);
}

// Build a public-safe party view from a user, honoring the caller's visibility.
async function partyFromUser(uid: string): Promise<RideParty | null> {
  const u = await store().getUser(uid);
  if (!u) return null;
  return {
    uid: u.uid,
    name: u.name,
    phone: u.phone,
    rating: u.rating,
    avatar: u.avatar,
    vehicleType: u.driverInfo?.vehicleType,
    brand: u.driverInfo?.brand,
    model: u.driverInfo?.model,
    color: u.driverInfo?.color,
    number: u.driverInfo?.number,
  };
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

  // Attach the counterpart's contact card once the relationship is established:
  // the passenger sees the driver after assignment; the driver sees the
  // passenger after accepting. Phone numbers are only shared at that point.
  const assigned = ['assigned', 'arrived', 'in_progress', 'completed'].includes(ride.status);
  let driver: RideParty | null = null;
  let passenger: RideParty | null = null;
  if (assigned && ride.driverId) driver = await partyFromUser(ride.driverId);
  if (assigned && ride.driverId === uid) passenger = await partyFromUser(ride.passengerId);

  res.json({ ...ride, driver, passenger });
}

// POST /api/rides/:id/offers — a driver bids a price on a negotiable ride.
export async function submitOffer(req: Request, res: Response): Promise<void> {
  const { amount, etaMin } = req.body as { amount: number; etaMin?: number };
  const ride = await store().getRide(req.params.id);
  if (!ride) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }
  if (!ride.negotiable || ride.status !== 'searching') {
    res.status(409).json({ error: 'Ride is not open for offers' });
    return;
  }
  const driver = await store().getUser(req.user!.uid);
  const offers = (ride.offers ?? []).filter((o) => o.driverId !== req.user!.uid);
  offers.push({
    driverId: req.user!.uid,
    driverName: driver?.name ?? 'Driver',
    driverRating: driver?.rating ?? 5,
    vehicleType: driver?.driverInfo?.vehicleType,
    amount: round(amount),
    etaMin,
    createdAt: nowIso(),
  });
  const updated = await store().updateRide(ride.id, { offers });
  // Push the refreshed offer list to the passenger in real time.
  sendToUser(ride.passengerId, { type: 'fare_offers', rideId: ride.id, offers });
  res.status(201).json(updated);
}

// POST /api/rides/:id/offers/accept — passenger picks a driver's offer.
export async function acceptOffer(req: Request, res: Response): Promise<void> {
  const { driverId } = req.body as { driverId: string };
  const ride = await store().getRide(req.params.id);
  if (!ride) {
    res.status(404).json({ error: 'Ride not found' });
    return;
  }
  if (ride.passengerId !== req.user!.uid) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const offer = ride.offers?.find((o) => o.driverId === driverId);
  if (!offer) {
    res.status(404).json({ error: 'Offer not found' });
    return;
  }
  const settings = await store().getSettings();
  const platformFee = round((offer.amount * settings.platformFeePercent) / 100);
  const updated = await store().updateRide(ride.id, {
    status: 'assigned',
    driverId,
    fare: offer.amount,
    platformFeePercent: settings.platformFeePercent,
    platformFee,
    driverEarnings: round(offer.amount - platformFee),
  });
  const driver = await partyFromUser(driverId);
  sendToUser(driverId, { type: 'ride_assigned', rideId: ride.id, driverId, driverInfo: driver });
  // Notify the passenger too so their tracking screen refreshes with the driver.
  sendToUser(ride.passengerId, { type: 'ride_status_update', rideId: ride.id, status: 'assigned', data: {} });
  broadcast({ type: 'ride_status_update', rideId: ride.id, status: 'assigned', data: {} }, 'driver');
  res.json(updated);
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
