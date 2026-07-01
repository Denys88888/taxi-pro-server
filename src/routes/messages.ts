import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { messageLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { getHistory, sendMessage } from '../controllers/messageController';
import { asyncHandler } from '../utils/asyncHandler';
import { MAX_MESSAGE_LENGTH } from '../config/constants';

const router = Router();

const sendSchema = z.object({
  chatId: z.string().min(1),
  text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  isTemplate: z.boolean().optional(),
});

router.get('/', requireAuth, asyncHandler(getHistory));
router.post('/', requireAuth, messageLimiter, validate(sendSchema), asyncHandler(sendMessage));

export default router;
