import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { savePushToken } from '../controllers/pushController';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const tokenSchema = z.object({
  token: z.string().min(1),
  platform: z.string().optional(),
});

// POST /api/push-token — store the caller's FCM token.
router.post('/', requireAuth, validate(tokenSchema), asyncHandler(savePushToken));

export default router;
