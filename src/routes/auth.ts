import { Router } from 'express';
import { z } from 'zod';
import { authLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { piAuth, devAuth } from '../controllers/authController';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const piAuthSchema = z.object({
  accessToken: z.string().min(1, 'accessToken is required'),
});

// POST /api/auth/pi — exchange a Pi accessToken for an app JWT.
router.post('/pi', authLimiter, validate(piAuthSchema), asyncHandler(piAuth));

const devAuthSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['passenger', 'driver', 'admin']).optional(),
});
router.post('/dev', authLimiter, validate(devAuthSchema), asyncHandler(devAuth));

export default router;
