import type { Request, Response } from 'express';
import { store } from '../models';
import { verifyPiAccessToken } from '../services/piService';
import { signToken } from '../utils/jwt';
import { nowIso } from '../utils/helpers';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import type { User } from '../types';

const adminUids = new Set(
  (env.ADMIN_UIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
);

// POST /api/auth/pi — verify a Pi accessToken, upsert the user, return a 24h JWT.
export async function piAuth(req: Request, res: Response): Promise<void> {
  const { accessToken } = req.body as { accessToken: string };

  const piUser = await verifyPiAccessToken(accessToken);
  if (!piUser) {
    res.status(401).json({ error: 'Invalid Pi access token' });
    return;
  }

  const existing = await store().getUser(piUser.uid);
  const isAdmin = adminUids.has(piUser.uid);
  const user: User = existing
    ? isAdmin && existing.role !== 'admin'
      ? { ...existing, role: 'admin' }
      : existing
    : {
        uid: piUser.uid,
        role: isAdmin ? 'admin' : 'passenger',
        name: piUser.username,
        rating: 5,
        ratingCount: 0,
        isBlocked: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
  await store().saveUser(user);

  if (user.isBlocked) {
    res.status(403).json({ error: 'Account blocked', reason: user.blockReason });
    return;
  }

  const token = signToken({ uid: user.uid, role: user.role, username: piUser.username });
  logger.info('[Auth] login', { uid: user.uid, role: user.role });
  res.json({ token, user });
}
