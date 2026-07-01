import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { getMe, updateMe } from '../controllers/userController';

const router = Router();

// Avatars are stored as data URLs or hosted URLs; cap size to keep docs small.
const updateSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    phone: z.string().min(5).max(20).optional(),
    avatar: z.string().max(500_000).optional(),
    preferredLanguage: z.string().min(2).max(8).optional(),
    preferredTheme: z.enum(['light', 'dark', 'auto']).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

router.use(requireAuth);
router.get('/me', asyncHandler(getMe));
router.patch('/me', validate(updateSchema), asyncHandler(updateMe));

export default router;
