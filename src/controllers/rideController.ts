import type { Request, Response } from 'express';
import { store } from '../models';
import { calculateFare } from '../services/fareCalculator';
import { getRouteInfo } from '../services/routingService';
import { getSurge } from '../services/surgeService';
import { releaseHeldPayment } from './paymentController';
import { genId, nowIso, round } from '../utils/helpers';
import { signShareToken } from '../utils/jwt';
import { LATE_CANCELLATION_FEE_PERCENT } from '../config/constants';
import { sendToUser, broadcast, broadcastToDriversOfType } from '../websocket/broadcast';
import type { Ride, GeoPoint, VehicleType, RideStatus, RideParty } from '../types';

// POST /api/rides — create a ride request (server computes distance + fare).
// Supports multi-stop, scheduled (future dispatch) and negotiable (inDriver) rides.
export async function createRide(req: Request, res: Response): Promise<void> {
  const { pickup, destination, vehicleType, stops, scheduledAt, negotiable, offeredFare, note } =
    req.body as {
      pickup: GeoPoint;
      destination: GeoPoint;
      vehicleType: VehicleType;
      stops?: GeoPoint[];
      scheduledAt?: string;
      negotiable?: boolean;
      offeredFare?: number;
      note?: string;
    };
  // One active ride per passenger: reject if they already have a non-terminal
  // ride, so the driver pool and the passenger's own tracking stay unambiguous.
  const ACTIVE: RideStatus[] = ['scheduled', 'searching', 'assigned', 'arrived', 'in_progress'];
  for (const st of ACTIVE) {
    const { total } = await store().listRidesByUser(req.user!.uid, st, 1, 1);
    if (total > 0) {
      res.status(409).json({ error: 'You already have an active ride', code: 'ACTIVE_RIDE_EXISTS' });
      return;
    }
  }

  const settings = await store().getSettings();
  // Distance follows the full path (pickup → stops… → destination) along the
  // road network; haversine is only the offline fallback inside getRouteInfo.
  const path = [pickup, ...(stops ?? []), destination];
  const [routeInfo, surge] = await Promise.all([
    getRouteInfo(path),
    settings.surgeEnabled !== false ? getSurge(pickup) : Promise.resolve({ multiplier: 1, reason: 'normal' as const }),
  ]);
  const distanceKm = round(routeInfo.distanceKm);
  const durationMin = routeInfo.durationMin;
  const breakdown = calculateFare({
    vehicleType,
    distanceKm,
    durationMin,
    surge: surge.multiplier,
    platformFeePercent: settings.platformFeePercent,
    minFare: settings.minFare,
    baseFarePerKm: settings.baseFarePerKm,
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
    ...(note && note.trim() ? { note: note.trim() } : {}),
    vehicleType,
    distanceKm,
    estimatedDurationMin: durationMin,
    ...fareBase,
    surgeMultiplier: surge.multiplier,
    paymentStatus: 'pending',
    status: isScheduled ? 'scheduled' : 'searching',
    ...(scheduledAt ? { scheduledAt } : {}),
    ...(negotiable ? { negotiable: true, offeredFare: round(offeredFare ?? breakdown.fare), offers: [] } : {}),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store().saveRide(ride);
  // Immediate rides are offered now, only to drivers registered for this
  // exact vehicle class (an economy driver must never see/accept a business
  // request); scheduled ones dispatch later via the same filtered path.
  if (!isScheduled) broadcastToDriversOfType({ type: 'ride_available', ride }, vehicleType);
  res.status(201).json(ride);
}

// GET /api/rides/surge?lat=&lng= — current surge multiplier at a point (or
// time-only if no coords). Shown to the passenger before ordering.
export async function getSurgeInfo(req: Request, res: Response): Promise<void> {
  const settings = await store().getSettings();
  if (settings.surgeEnabled === false) {
    res.json({ multiplier: 1, reason: 'normal' });
    return;
  }
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const point = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
  res.json(await getSurge(point));
}

// GET /api/rides/open — open requests for drivers coming online: 'searching'
// rides from the last 30 minutes, so requests created before the driver
// connected are not lost (the live 'ride_available' WS event only reaches
// drivers connected at creation time).
export async function listOpenRides(req: Request, res: Response): Promise<void> {
  const since = Date.now() - 30 * 60 * 1000;
  const searching = await store().listAllRides('searching');
  const rides = searching
    .filter(
      (r) =>
        r.passengerId !== req.user!.uid &&
        new Date(r.createdAt).getTime() >= since &&
        (!r.scheduledAt || new Date(r.scheduledAt).getTime() <= Date.now())
    )
    .slice(0, 20);
  res.json({ rides });
}

// GET /api/rides/heatmap — demand hotspots for drivers: pickups of rides that
// went unserved (still searching or cancelled) in the last 30 minutes, grouped
// into ~1 km cells with a weight per cell.
export async function getHeatmap(_req: Request, res: Response): Promise<void> {
  const since = Date.now() - 30 * 60 * 1000;
  const [searching, cancelled] = await Promise.all([
    store().listAllRides('searching'),
    store().listAllRides('cancelled'),
  ]);
  const cells = new Map<string, { lat: number; lng: number; weight: number }>();
  for (const ride of [...searching, ...cancelled]) {
    if (new Date(ride.createdAt).getTime() < since) continue;
    const lat = Math.round(ride.pickup.lat * 100) / 100;
    const lng = Math.round(ride.pickup.lng * 100) / 100;
    const key = `${lat},${lng}`;
    const cell = cells.get(key) ?? { lat, lng, weight: 0 };
    cell.weight += 1;
    cells.set(key, cell);
  }
  res.json({ points: [...cells.values()] });
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
  // Only a verified/approved driver may bid — mirrors the ride_accept WS guard.
  if (!driver?.driverInfo || driver.driverInfo.applicationStatus !== 'approved') {
    res.status(403).json({ error: 'Only approved drivers can submit offers' });
    return;
  }
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
  // Each party may only rate the OTHER party, and only once the ride is done.
  // Passenger → driverRating/driverReview; driver → passengerRating/passengerReview.
  const isPassenger = ride.passengerId === uid;
  const allowed = isPassenger
    ? (['driverRating', 'driverReview'] as const)
    : (['passengerRating', 'passengerReview'] as const);
  const wantsRating = ['passengerRating', 'driverRating', 'passengerReview', 'driverReview'].some(
    (k) => req.body[k] !== undefined
  );
  if (wantsRating && ride.status !== 'completed') {
    res.status(409).json({ error: 'Can only rate a completed ride' });
    return;
  }
  const patch: Partial<Ride> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) (patch as Record<string, unknown>)[key] = req.body[key];
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'No permitted fields to update' });
    return;
  }
  const updated = await store().updateRide(req.params.id, patch);
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
  // Escrow: a held payment is refunded; a pending (not yet initiated) payment
  // is marked cancelled so the UI doesn't show "Awaiting payment" on cancelled rides.
  const paymentStatus = ride.paymentStatus === 'held' ? 'refunded'
    : ride.paymentStatus === 'pending' ? 'cancelled'
    : ride.paymentStatus;
  if (ride.paymentStatus === 'held' && ride.paymentId) {
    await releaseHeldPayment(ride.paymentId);
  }
  const updated = await store().updateRide(req.params.id, {
    status: 'cancelled',
    cancelledBy: req.user!.role,
    cancellationReason: String(req.body.reason),
    cancellationFee,
    ...(paymentStatus ? { paymentStatus } : {}),
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
