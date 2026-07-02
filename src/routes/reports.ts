import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { createReport } from '../controllers/reportController';

const router = Router();

const reportSchema = z.object({
  rideId: z.string().min(1),
  reportedId: z.string().min(1),
  reason: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

router.post('/', requireAuth, validate(reportSchema), asyncHandler(createReport));

export default router;
