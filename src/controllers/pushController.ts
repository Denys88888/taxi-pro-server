import type { Request, Response } from 'express';
import { store } from '../models';
import { nowIso } from '../utils/helpers';

// POST /api/push-token — store the caller's FCM token for later notifications.
export async function savePushToken(req: Request, res: Response): Promise<void> {
  const { token, platform } = req.body as { token: string; platform?: string };
  await store().savePushToken({
    userId: req.user!.uid,
    token,
    platform: platform ?? 'web',
    updatedAt: nowIso(),
  });
  res.json({ success: true });
}
