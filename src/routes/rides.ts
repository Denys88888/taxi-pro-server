import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createRide,
  listRides,
  getRide,
  updateRide,
  cancelRide,
  shareRide,
} from '../controllers/rideController';

const router = Router();

const geoSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().max(300).optional(),
});
const vehicleSchema = z.enum(['economy', 'comfort', 'business', 'xl']);

const createSchema = z.object({
  pickup: geoSchema,
  destination: geoSchema,
  vehicleType: vehicleSchema,
});

const updateSchema = z
  .object({
    status: z
      .enum(['searching', 'assigned', 'arrived', 'in_progress', 'completed', 'cancelled'])
      .optional(),
    passengerRating: z.number().min(1).max(5).optional(),
    driverRating: z.number().min(1).max(5).optional(),
    passengerReview: z.string().max(500).optional(),
    driverReview: z.string().max(500).optional(),
    txid: z.string().optional(),
    paymentId: z.string().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

const cancelSchema = z.object({
  reason: z.string().min(1).max(300),
});

router.use(requireAuth);

router.post('/', validate(createSchema), asyncHandler(createRide));
router.get('/', asyncHandler(listRides));
router.get('/:id', asyncHandler(getRide));
router.patch('/:id', validate(updateSchema), asyncHandler(updateRide));
router.post('/:id/cancel', validate(cancelSchema), asyncHandler(cancelRide));
router.post('/:id/share', asyncHandler(shareRide));

export default router;
