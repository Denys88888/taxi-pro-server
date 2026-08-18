import type { Request, Response } from 'express';
import { store } from '../models';
import { findNearbyDrivers } from '../services/rideMatching';
import { forgetOnlineDrivers } from '../services/onlineDrivers';
import { forgetDriverLocation, persistDriverLocation } from '../services/driverLocation';
import { nowIso, round, isApprovedDriver } from '../utils/helpers';
import type { DriverInfo, GeoPoint, VehicleType } from '../types';

// POST /api/drivers/register — become a driver (submits vehicle details for review).
export async function registerDriver(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    vehicleType: VehicleType;
    brand: string;
    model: string;
    color: string;
    number: string;
    vehicleYear: number;
    seats?: number;
    vehiclePhoto?: string;
    licensePhoto?: string;
  };
  const user = await store().getUser(req.user!.uid);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  // The client only ever reaches this screen when the account has no
  // driverInfo yet (ProfileScreen hides the button once it does), but that's
  // UI, not a boundary the endpoint itself enforced — nothing stopped a
  // second call from overwriting an *approved* driver's info and resetting
  // applicationStatus back to 'pending', demoting them mid-shift with no
  // warning. Resubmitting after a rejection, or before a first verdict, is
  // the legitimate case and stays allowed.
  if (isApprovedDriver(user.driverInfo)) {
    res.status(409).json({ error: 'Already an approved driver' });
    return;
  }
  const driverInfo: DriverInfo = {
    vehicleType: body.vehicleType,
    brand: body.brand,
    model: body.model,
    color: body.color,
    number: body.number,
    vehicleYear: body.vehicleYear,
    seats: body.seats,
    vehiclePhoto: body.vehiclePhoto,
    licensePhoto: body.licensePhoto,
    licenseVerified: false, // pending admin approval
    applicationStatus: 'pending',
    isOnline: false,
  };
  // Role stays 'passenger' until an admin verifies; store the pending driverInfo.
  const updated = await store().updateUser(req.user!.uid, { driverInfo });
  forgetOnlineDrivers();
  res.status(201).json({ status: 'pending_verification', user: updated });
}

// POST /api/drivers/location — update the driver's current GPS position.
export async function updateLocation(req: Request, res: Response): Promise<void> {
  const { lat, lng } = req.body as { lat: number; lng: number };
  const lastLocation: GeoPoint = { lat, lng };
  // The app sends every position twice — here and over the socket — so the two
  // channels share one throttle, and the second of each pair costs nothing.
  if (!(await persistDriverLocation(req.user!.uid, lastLocation))) {
    res.status(400).json({ error: 'Not a driver' });
    return;
  }
  res.json({ success: true, lastLocation, updatedAt: nowIso() });
}

// GET /api/drivers/nearby?lat=&lng=&radius=&vehicleType= — find nearby online drivers.
export async function nearbyDrivers(req: Request, res: Response): Promise<void> {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    res.status(400).json({ error: 'lat and lng are required' });
    return;
  }
  const radius = Number(req.query.radius) || undefined;
  const vehicleType = req.query.vehicleType as VehicleType | undefined;
  const results = await findNearbyDrivers({ lat, lng }, vehicleType, radius);
  res.json({
    drivers: results.map(({ driver, distanceKm }) => ({
      uid: driver.uid,
      name: driver.name,
      rating: driver.rating,
      vehicleType: driver.driverInfo?.vehicleType,
      location: driver.driverInfo?.lastLocation,
      distanceKm: round(distanceKm),
    })),
  });
}

// POST /api/drivers/online — go online (must be a verified driver).
export async function goOnline(req: Request, res: Response): Promise<void> {
  const user = await store().getUser(req.user!.uid);
  if (!user?.driverInfo || !isApprovedDriver(user.driverInfo)) {
    res.status(403).json({ error: 'Driver not verified' });
    return;
  }
  const settings = await store().getSettings();
  if (settings.maintenanceMode) {
    res.status(503).json({ error: 'Ordering is temporarily disabled for maintenance', code: 'MAINTENANCE' });
    return;
  }
  // Only enforce once the driver has actually been rated a few times — a
  // brand-new driver's default rating must never block their first rides.
  if ((user.ratingCount ?? 0) >= 3 && user.rating < settings.minDriverRating) {
    res.status(403).json({ error: 'Rating below the minimum required to go online', code: 'RATING_TOO_LOW' });
    return;
  }
  const body = req.body as { lat?: number; lng?: number };
  const lastLocation =
    body.lat !== undefined && body.lng !== undefined
      ? { lat: body.lat, lng: body.lng }
      : user.driverInfo.lastLocation;
  await store().updateUser(req.user!.uid, {
    driverInfo: { ...user.driverInfo, isOnline: true, lastLocation },
  });
  forgetOnlineDrivers();
  res.json({ success: true, isOnline: true });
}

// POST /api/drivers/offline — go offline.
export async function goOffline(req: Request, res: Response): Promise<void> {
  forgetDriverLocation(req.user!.uid);
  const user = await store().getUser(req.user!.uid);
  if (!user?.driverInfo) {
    res.status(400).json({ error: 'Not a driver' });
    return;
  }
  await store().updateUser(req.user!.uid, {
    driverInfo: { ...user.driverInfo, isOnline: false },
  });
  forgetOnlineDrivers();
  res.json({ success: true, isOnline: false });
}
