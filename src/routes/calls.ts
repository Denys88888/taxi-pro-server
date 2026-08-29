import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { getTurnCredentials } from '../controllers/callController';

const router = Router();

router.use(requireAuth);
router.get('/turn-credentials', asyncHandler(getTurnCredentials));

export default router;
