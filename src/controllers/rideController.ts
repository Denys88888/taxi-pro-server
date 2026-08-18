import type { Request, Response } from 'express';
import { store } from '../models';
import { calculateFare } from '../services/fareCalculator';
import { getRouteInfo } from '../services/routingService';
import { getSurge } from '../services/surgeService';
import { releaseHeldPayment } from './paymentController';
import { genId, nowIso, round, isApprovedDriver } from '../utils/helpers';
import { signShareToken } from '../utils/jwt';
import { TtlCache } from '../utils/ttlCache';
import {
  LATE_CANCELLATION_FEE_PERCENT,
  FREE_CANCELLATION_AFTER_ARRIVAL_MIN,
  MAX_PENDING_SCHEDULED_RIDES,
  SCHEDULED_MIN_GAP_MS,
} from '../config/constants';
import { sendToUser, broadcast, broadcastToDriversOfType } from '../websocket/broadcast';
import { initialOffered } from '../services/scheduler';
import { hasLiveRide } from '../services/activeRide';
import { findOutstandingFee } from '../services/cancellationFee';
import type { Ride, GeoPoint, VehicleType, RideStatus, RideParty, Role } from '../types';

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
  // One ride *under way* per passenger, so the driver pool and the passenger's
  // own tracking stay unambiguous. A ride merely booked for later does not
  // count: refusing on it meant someone who scheduled a trip for tomorrow
  // morning could not order a taxi today at all.
  if (await hasLiveRide(req.user!.uid)) {
    res.status(409).json({ error: 'You already have an active ride', code: 'ACTIVE_RIDE_EXISTS' });
    return;
  }

  // An unpaid late-cancellation fee blocks the next booking. Pi has no card on
  // file to charge, so a passenger who walks away from the payment sheet cannot
  // be billed by any other means — refusing the next ride until they settle is
  // the whole reason the fee is more than a number in a dialog. The amount goes
  // back with the refusal so the app can offer to pay it on the spot.
  const owed = await findOutstandingFee(req.user!.uid);
  if (owed) {
    res.status(409).json({
      error: 'An unpaid cancellation fee is outstanding',
      code: 'CANCELLATION_FEE_DUE',
      rideId: owed.id,
      amount: owed.cancellationFee,
    });
    return;
  }

  // Future-dated rides wait as 'scheduled'; the dispatcher promotes them when due.
  const isScheduled = !!scheduledAt && new Date(scheduledAt).getTime() > Date.now();

  // Bookings are cheap to make and expensive to keep, so they are capped, and
  // two of them may not land on top of each other — the dispatcher can only
  // send one at a time, so the second would go out late through no fault of
  // the passenger's.
  if (isScheduled) {
    const { rides } = await store().listRidesByUser(req.user!.uid, 'scheduled', 1, 100);
    const booked = rides.filter((r) => r.passengerId === req.user!.uid);
    if (booked.length >= MAX_PENDING_SCHEDULED_RIDES) {
      res.status(409).json({
        error: `You can have at most ${MAX_PENDING_SCHEDULED_RIDES} scheduled rides`,
        code: 'TOO_MANY_SCHEDULED',
      });
      return;
    }
    const at = new Date(scheduledAt!).getTime();
    const clash = booked.some(
      (r) => r.scheduledAt && Math.abs(new Date(r.scheduledAt).getTime() - at) < SCHEDULED_MIN_GAP_MS
    );
    if (clash) {
      res.status(409).json({
        error: 'You already have a ride booked around that time',
        code: 'SCHEDULED_CONFLICT',
      });
      return;
    }
  }

  const settings = await store().getSettings();
  if (settings.maintenanceMode) {
    res.status(503).json({ error: 'Ordering is temporarily disabled for maintenance', code: 'MAINTENANCE' });
    return;
  }
  // Distance follows the full path (pickup → stops… → destination) along the
  // road network; haversine is only the offline fallback inside getRouteInfo.
  const path = [pickup, ...(stops ?? []), destination];
  const [routeInfo, surge] = await Promise.all([
    getRouteInfo(path),
    // Priced by the clock the ride runs on, not the clock the passenger booked
    // on — otherwise a booking made late at night carries the night multiplier
    // into the middle of the following afternoon, frozen, for good.
    settings.surgeEnabled !== false
      ? getSurge(pickup, isScheduled ? new Date(scheduledAt!) : undefined)
      : Promise.resolve({ multiplier: 1, reason: 'normal' as const }),
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
    // Only an immediate ride starts searching now; a scheduled one gets this
    // stamped by the dispatcher when it promotes the ride.
    ...(isScheduled ? {} : { searchStartedAt: nowIso() }),
    ...(negotiable ? { negotiable: true, offeredFare: round(offeredFare ?? breakdown.fare), offers: [] } : {}),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store().saveRide(ride);
  // Immediate rides are offered now, only to drivers of a compatible
  // class AND within maxSearchRadiusKm of pickup; scheduled ones dispatch
  // later via the same filtered path in scheduler.ts. If no driver
  // accepts within the offer timeout, scheduler.ts expands the radius.
  if (!isScheduled) {
    const offered = broadcastToDriversOfType(
      { type: 'ride_available', ride },
      vehicleType,
      pickup,
      settings.maxSearchRadiusKm
    );
    initialOffered.set(ride.id, new Set(offered));
  }
  res.status(201).json(ride);
}

// GET /api/rides/surge?lat=&lng=&at= — the surge multiplier at a point (or
// time-only if no coords). Shown to the passenger before ordering. `at` is the
// ISO time the ride is for; it must be passed when the passenger is booking
// ahead, or the quote on screen is priced by a different clock than the fare
// they are about to be charged.
export async function getSurgeInfo(req: Request, res: Response): Promise<void> {
  const settings = await store().getSettings();
  if (settings.surgeEnabled === false) {
    res.json({ multiplier: 1, reason: 'normal' });
    return;
  }
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const point = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
  // A malformed or past `at` falls back to now rather than 400ing: this only
  // feeds a price preview, and no quote at all is worse than one for now.
  const at = typeof req.query.at === 'string' ? new Date(req.query.at) : undefined;
  const validAt = at && !Number.isNaN(at.getTime()) && at.getTime() > Date.now() ? at : undefined;
  res.json(await getSurge(point, validAt));
}

// GET /api/rides/open — open requests for drivers coming online: 'searching'
// rides from the last 30 minutes, so requests created before the driver
// connected are not lost (the live 'ride_available' WS event only reaches
// drivers connected at creation time).
// Same answer for every driver, asked for by each of them every 15 seconds.
// Slowing the poll down would have cost responsiveness; sharing the query costs
// nothing, and makes the price of this endpoint flat instead of one more bill
// per driver on shift.
//
// A ride accepted seconds ago can still appear here until the entry expires,
// but that race predates the cache and the server already settles it: taking a
// ride re-reads its real state and refuses if someone else got there first.
const OPEN_RIDES_TTL_MS = 10_000;
const openRides = new TtlCache<Ride[]>(OPEN_RIDES_TTL_MS, 1);

export async function listOpenRides(req: Request, res: Response): Promise<void> {
  const since = Date.now() - 30 * 60 * 1000;
  const searching = await openRides.get('all', () => store().listAllRides('searching'));
  const rides = searching
    .filter(
      (r) =>
        r.passengerId !== req.user!.uid &&
        // Freshness is measured from when the ride started looking for a
        // driver. A scheduled ride booked this morning and dispatched just now
        // is a brand-new request; judging it by createdAt hid it from every
        // driver who came online after it was promoted.
        new Date(r.searchStartedAt ?? r.createdAt).getTime() >= since &&
        (!r.scheduledAt || new Date(r.scheduledAt).getTime() <= Date.now())
    )
    .slice(0, 20);
  res.json({ rides });
}

// GET /api/rides/heatmap — demand hotspots for drivers: pickups of rides that
// went unserved (still searching or cancelled) in the last 30 minutes, grouped
// into ~1 km cells with a weight per cell.
interface HeatCell {
  lat: number;
  lng: number;
  weight: number;
}

// The answer takes no parameters — it is the same picture of the last half hour
// for every driver looking at it — yet every driver online asked for it on their
// own timer, each request paying to read the whole window again. Computed once
// and shared instead. A minute of lag is nothing against a 30-minute window
// that only ever shifts by whole rides.
const HEATMAP_TTL_MS = 60_000;
const heatmap = new TtlCache<HeatCell[]>(HEATMAP_TTL_MS, 1);

async function buildHeatmap(): Promise<HeatCell[]> {
  // Bound the read to the 30-minute window in the query — listing all cancelled
  // rides and then discarding the old ones meant the cost of this endpoint grew
  // with every ride the platform had ever taken.
  const since = Date.now() - 30 * 60 * 1000;
  const sinceIso = new Date(since).toISOString();
  // One query, not one per status: the store cannot filter status and a time
  // range together without a composite index, so asking for each status
  // separately read the identical set of documents twice and threw half away.
  const recent = await store().listRidesSince(sinceIso);
  const cells = new Map<string, HeatCell>();
  for (const ride of recent) {
    if (ride.status !== 'searching' && ride.status !== 'cancelled') continue;
    if (new Date(ride.createdAt).getTime() < since) continue;
    const lat = Math.round(ride.pickup.lat * 100) / 100;
    const lng = Math.round(ride.pickup.lng * 100) / 100;
    const key = `${lat},${lng}`;
    const cell = cells.get(key) ?? { lat, lng, weight: 0 };
    cell.weight += 1;
    cells.set(key, cell);
  }
  return [...cells.values()];
}

export async function getHeatmap(_req: Request, res: Response): Promise<void> {
  res.json({ points: await heatmap.get('all', buildHeatmap) });
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
    // The plate and model alone make a rider check cars one by one at a busy
    // pickup; the photo is how they spot the right one. Deliberately not
    // licensePhoto — that is the driver's document, never the rider's business.
    vehiclePhoto: u.driverInfo?.vehiclePhoto,
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
  // Same gates as the ride_accept WS handler, and through the same helper so
  // they cannot drift apart again: a bid is an offer to take the ride, so a
  // driver who can't accept must not be able to bid either. Reading
  // applicationStatus directly here used to lock out drivers approved before
  // that field existed — they carry only licenseVerified.
  if (!driver?.driverInfo || !isApprovedDriver(driver.driverInfo)) {
    res.status(403).json({ error: 'Only approved drivers can submit offers' });
    return;
  }
  if (driver.isBlocked) {
    res.status(403).json({ error: 'Account blocked' });
    return;
  }
  if (!driver.driverInfo.isOnline) {
    res.status(409).json({ error: 'You are offline' });
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
  // submitOffer requires 'searching' to bid; accepting must require the same
  // — otherwise offers, which are never cleared once one is accepted, let a
  // second accept call silently swap the assigned driver out from under the
  // first one (no cancellation, no notice to them) any time after the ride
  // moved on. The client already hides the offers list once assigned, which
  // stops an accidental double-tap, but that's UI, not a security boundary —
  // this is the same check reachable directly against the API.
  if (ride.status !== 'searching') {
    res.status(409).json({ error: 'Ride is not open for offers' });
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
    ? (['driverRating', 'driverReview', 'driverRatingBreakdown'] as const)
    : (['passengerRating', 'passengerReview'] as const);
  const wantsRating = [
    'passengerRating',
    'driverRating',
    'passengerReview',
    'driverReview',
    'driverRatingBreakdown',
  ].some((k) => req.body[k] !== undefined);
  if (wantsRating && ride.status !== 'completed') {
    res.status(409).json({ error: 'Can only rate a completed ride' });
    return;
  }
  // Prevent double-rating — once submitted it cannot be changed. The breakdown
  // is part of the same submission, so it is sealed by the same check.
  if (
    isPassenger &&
    ride.driverRating !== undefined &&
    (req.body.driverRating !== undefined || req.body.driverRatingBreakdown !== undefined)
  ) {
    res.status(409).json({ error: 'Already rated this ride' });
    return;
  }
  if (!isPassenger && ride.passengerRating !== undefined && req.body.passengerRating !== undefined) {
    res.status(409).json({ error: 'Already rated this ride' });
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
  // Which side of *this* ride is cancelling. Taken from the ride, not from the
  // role on the token: the app lets a user switch between passenger and driver
  // mode, so someone who accepted a ride as a driver and later flipped back to
  // passenger mode still owns the driver's side of it. Reading req.user.role
  // filed those cancellations under the wrong party.
  const cancellerRole: Role = ride.driverId === uid ? 'driver' : 'passenger';
  // Free before arrival, and for a grace window after arrival (the rider may be
  // on their way out, or the driver may be at the wrong spot). A fee applies
  // once the trip is in progress, or once the grace window has elapsed.
  //
  // Only to the passenger, though. The fee is compensation for wasting the
  // driver's time; when it is the driver who walks away from a trip already
  // under way, the passenger is the one left standing on the pavement, and
  // billing them half the fare for it is exactly backwards.
  //
  // A ride that reached 'arrived' without an arrivedAt is a hole in our own
  // records — the handler stamps the two together, so the timestamp only goes
  // missing if something went wrong on our side. Treating its absence as "the
  // window closed long ago" charged the passenger half the fare for a moment
  // nobody can point to; the benefit of the doubt goes to them.
  const graceMs = FREE_CANCELLATION_AFTER_ARRIVAL_MIN * 60 * 1000;
  const withinGrace =
    ride.status === 'arrived' &&
    (!ride.arrivedAt || Date.now() - new Date(ride.arrivedAt).getTime() < graceMs);
  const feeApplies =
    cancellerRole === 'passenger' &&
    (ride.status === 'in_progress' || (ride.status === 'arrived' && !withinGrace));
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
    cancelledBy: cancellerRole,
    cancellationReason: String(req.body.reason),
    cancellationFee,
    // The fee is owed, not taken. The escrowed fare is one Pi payment for the
    // full amount and Pi cannot capture part of one, so the hold goes back
    // whole (above) and the fee is collected as its own payment the passenger
    // approves afterwards. Until then it is a debt that blocks new bookings.
    ...(cancellationFee > 0 ? { cancellationFeeStatus: 'outstanding' as const } : {}),
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

// GET /api/rides/outstanding-fee — the late-cancellation fee this passenger
// still owes, if any. The create-ride refusal already carries the amount, but
// the app needs to know before the passenger fills in a whole trip only to be
// turned away at the last step.
export async function getOutstandingFee(req: Request, res: Response): Promise<void> {
  const owed = await findOutstandingFee(req.user!.uid);
  res.json(
    owed
      ? { rideId: owed.id, amount: owed.cancellationFee, cancelledAt: owed.updatedAt }
      : null
  );
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
