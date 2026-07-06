import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  registerDriver,
  updateLocation,
  nearbyDrivers,
  goOnline,
  goOffline,
} from '../controllers/driverController';

const router = Router();

const registerSchema = z.object({
  vehicleType: z.enum(['economy', 'comfort', 'business', 'xl']),
  brand: z.string().min(1).max(50),
  model: z.string().min(1).max(50),
  color: z.string().min(1).max(30),
  number: z.string().min(1).max(20),
  vehiclePhoto: z.string().url().optional(),
  licensePhoto: z.string().url().optional(),
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
router.post('/location', requireRole('driver'), validate(locationSchema), asyncHandler(updateLocation));
router.post('/online', requireRole('driver'), validate(onlineSchema), asyncHandler(goOnline));
router.post('/offline', requireRole('driver'), asyncHandler(goOffline));

export default router;
