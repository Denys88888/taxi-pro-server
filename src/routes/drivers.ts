import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { VEHICLE_CLASS_REQUIREMENTS } from '../config/constants';
import {
  registerDriver,
  updateLocation,
  nearbyDrivers,
  goOnline,
  goOffline,
} from '../controllers/driverController';

const router = Router();

const registerSchema = z
  .object({
    vehicleType: z.enum(['economy', 'comfort', 'business', 'xl']),
    brand: z.string().min(1).max(50),
    model: z.string().min(1).max(50),
    color: z.string().min(1).max(30),
    number: z.string().min(1).max(20),
    vehicleYear: z.coerce.number().int().min(1980).max(new Date().getFullYear() + 1),
    seats: z.coerce.number().int().min(1).max(20).optional(),
    vehiclePhoto: z.string().url().optional(),
    licensePhoto: z.string().url().optional(),
  })
  // Defense in depth against a tampered client — the wizard already blocks
  // this in the UI, but a direct API call must not be able to bypass the
  // per-class minimums (see VEHICLE_CLASS_REQUIREMENTS).
  .superRefine((data, ctx) => {
    const req = VEHICLE_CLASS_REQUIREMENTS[data.vehicleType];
    if (data.vehicleYear < req.minYear) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vehicleYear'],
        message: `${data.vehicleType} requires a vehicle from ${req.minYear} or newer`,
      });
    }
    if (req.minSeats && (!data.seats || data.seats < req.minSeats)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['seats'],
        message: `${data.vehicleType} requires at least ${req.minSeats} seats`,
      });
    }
  });

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const onlineSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

router.use(requireAuth);

router.post('/register', validate(registerSchema), asyncHandler(registerDriver));
router.get('/nearby', asyncHandler(nearbyDrivers));
// No requireRole here: the JWT role claim goes stale when an admin approves a
// driver mid-session (the token still says 'passenger'). The controllers gate
// on the CURRENT store state (licenseVerified / driverInfo) instead.
router.post('/location', validate(locationSchema), asyncHandler(updateLocation));
router.post('/online', validate(onlineSchema), asyncHandler(goOnline));
router.post('/offline', asyncHandler(goOffline));

export default router;
