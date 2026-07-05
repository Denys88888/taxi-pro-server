import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  getStats,
  listUsers,
  updateUserBlock,
  listAllRides,
  listReports,
  resolveReport,
  getSettings,
  updateSettings,
  pendingDrivers,
  verifyDriver,
  listDrivers,
  getAnalytics,
} from '../controllers/adminController';

const router = Router();

const blockSchema = z.object({
  isBlocked: z.boolean(),
  blockReason: z.string().max(300).optional(),
});
const resolveSchema = z.object({
  status: z.enum(['resolved', 'dismissed']),
});
const settingsSchema = z
  .object({
    platformFeePercent: z.number().min(0).max(20).optional(),
    surgeEnabled: z.boolean().optional(),
    minFare: z.number().min(0).max(100).optional(),
    baseFarePerKm: z.number().min(0.1).max(10).optional(),
    appName: z.string().min(1).max(60).optional(),
    appLogo: z.string().optional(),
    contactEmail: z.string().email().optional(),
    maintenanceMode: z.boolean().optional(),
    maxSearchRadiusKm: z.number().min(1).max(50).optional(),
    extendedSearchRadiusKm: z.number().min(1).max(100).optional(),
    minDriverRating: z.number().min(0).max(5).optional(),
    autoBlockThreshold: z.number().min(1).max(100).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No settings to update' });
const verifySchema = z.object({ approve: z.boolean() });

// All admin routes require an authenticated admin.
router.use(requireAuth, requireRole('admin'));

router.get('/stats', asyncHandler(getStats));
router.get('/users', asyncHandler(listUsers));
router.patch('/users/:id', validate(blockSchema), asyncHandler(updateUserBlock));
router.get('/rides', asyncHandler(listAllRides));
router.get('/reports', asyncHandler(listReports));
router.patch('/reports/:id', validate(resolveSchema), asyncHandler(resolveReport));
router.get('/settings', asyncHandler(getSettings));
router.patch('/settings', validate(settingsSchema), asyncHandler(updateSettings));
router.get('/analytics', asyncHandler(getAnalytics));
router.get('/drivers', asyncHandler(listDrivers));
router.get('/drivers/pending', asyncHandler(pendingDrivers));
router.post('/drivers/:id/verify', validate(verifySchema), asyncHandler(verifyDriver));

export default router;
