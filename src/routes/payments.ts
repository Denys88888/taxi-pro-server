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
  cancelIncompletePayment,
  cancelUnknownPiPayment,
} from '../controllers/paymentController';

const router = Router();

const createSchema = z.object({
  rideId: z.string().min(1),
  type: z.enum(['ride', 'tip']).optional(),
  amount: z.number().positive().max(100).optional(),
});
const approveSchema = z.object({ piPaymentId: z.string().min(1) });
const completeSchema = z.object({
  piPaymentId: z.string().min(1),
  txid: z.string().min(1),
});

router.use(requireAuth);

router.post('/', validate(createSchema), asyncHandler(createPayment));
// Literal routes must precede /:id so Express doesn't match 'cancel-unknown-pi' as a payment id.
router.post('/cancel-unknown-pi', validate(approveSchema), asyncHandler(cancelUnknownPiPayment));
router.get('/:id', asyncHandler(getPayment));
router.post('/:id/approve', validate(approveSchema), asyncHandler(approvePayment));
router.post('/:id/complete', validate(completeSchema), asyncHandler(completePayment));
router.post('/:id/cancel', validate(approveSchema), asyncHandler(cancelIncompletePayment));

export default router;
