import type { Request, Response } from 'express';
import { store } from '../models';
import { findNearbyDrivers } from '../services/rideMatching';
import { nowIso, round } from '../utils/helpers';
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
  res.status(201).json({ status: 'pending_verification', user: updated });
}

// POST /api/drivers/location — update the driver's current GPS position.
export async function updateLocation(req: Request, res: Response): Promise<void> {
  const { lat, lng } = req.body as { lat: number; lng: number };
  const user = await store().getUser(req.user!.uid);
  if (!user?.driverInfo) {
    res.status(400).json({ error: 'Not a driver' });
    return;
  }
  const lastLocation: GeoPoint = { lat, lng };
  await store().updateUser(req.user!.uid, {
    driverInfo: { ...user.driverInfo, lastLocation },
  });
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
  if (!user?.driverInfo?.licenseVerified) {
    res.status(403).json({ error: 'Driver not verified' });
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
  res.json({ success: true, isOnline: true });
}

// POST /api/drivers/offline — go offline.
export async function goOffline(req: Request, res: Response): Promise<void> {
  const user = await store().getUser(req.user!.uid);
  if (!user?.driverInfo) {
    res.status(400).json({ error: 'Not a driver' });
    return;
  }
  await store().updateUser(req.user!.uid, {
    driverInfo: { ...user.driverInfo, isOnline: false },
  });
  res.json({ success: true, isOnline: false });
}
