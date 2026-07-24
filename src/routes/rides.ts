import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { rideCreateLimiter } from '../middleware/rateLimit';
import {
  createRide,
  listRides,
  getRide,
  updateRide,
  cancelRide,
  shareRide,
  submitOffer,
  acceptOffer,
  getSurgeInfo,
  getHeatmap,
  listOpenRides,
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
  stops: z.array(geoSchema).max(5).optional(),
  scheduledAt: z.string().datetime().optional(),
  negotiable: z.boolean().optional(),
  offeredFare: z.number().positive().max(10000).optional(),
  note: z.string().max(200).optional(),
});

const offerSchema = z.object({
  amount: z.number().positive().max(10000),
  etaMin: z.number().int().min(0).max(120).optional(),
});
const acceptOfferSchema = z.object({ driverId: z.string().min(1) });

const updateSchema = z
  .object({
    status: z
      .enum(['searching', 'assigned', 'arrived', 'in_progress', 'completed', 'cancelled'])
      .optional(),
    passengerRating: z.number().min(1).max(5).optional(),
    driverRating: z.number().min(1).max(5).optional(),
    passengerReview: z.string().max(500).optional(),
    driverReview: z.string().max(500).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

const cancelSchema = z.object({
  reason: z.string().min(1).max(300),
});

router.use(requireAuth);

router.post('/', rideCreateLimiter, validate(createSchema), asyncHandler(createRide));
router.get('/', asyncHandler(listRides));
// Static paths must precede '/:id'.
router.get('/surge', asyncHandler(getSurgeInfo));
router.get('/open', asyncHandler(listOpenRides));
router.get('/heatmap', asyncHandler(getHeatmap));
router.get('/:id', asyncHandler(getRide));
router.patch('/:id', validate(updateSchema), asyncHandler(updateRide));
router.post('/:id/cancel', validate(cancelSchema), asyncHandler(cancelRide));
router.post('/:id/share', asyncHandler(shareRide));
router.post('/:id/offers', requireRole('driver'), validate(offerSchema), asyncHandler(submitOffer));
router.post('/:id/offers/accept', validate(acceptOfferSchema), asyncHandler(acceptOffer));

export default router;
