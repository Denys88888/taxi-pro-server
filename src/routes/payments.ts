import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createPayment,
  getPayment,
  approvePayment,
  completePayment,
} from '../controllers/paymentController';

const router = Router();

const createSchema = z.object({ rideId: z.string().min(1) });
const approveSchema = z.object({ piPaymentId: z.string().min(1) });
const completeSchema = z.object({
  piPaymentId: z.string().min(1),
  txid: z.string().min(1),
});

router.use(requireAuth);

router.post('/', validate(createSchema), asyncHandler(createPayment));
router.get('/:id', asyncHandler(getPayment));
router.post('/:id/approve', validate(approveSchema), asyncHandler(approvePayment));
router.post('/:id/complete', validate(completeSchema), asyncHandler(completePayment));

export default router;
