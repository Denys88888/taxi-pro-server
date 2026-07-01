import type { Request, Response } from 'express';
import { store } from '../models';
import type { User } from '../types';

// GET /api/users/me — the authenticated user's own profile.
export async function getMe(req: Request, res: Response): Promise<void> {
  const user = await store().getUser(req.user!.uid);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
}

// PATCH /api/users/me — update editable profile fields (name, phone, avatar,
// language, theme). Avatar is a data URL or hosted URL supplied by the client.
export async function updateMe(req: Request, res: Response): Promise<void> {
  const body = req.body as Partial<
    Pick<User, 'name' | 'phone' | 'avatar' | 'preferredLanguage' | 'preferredTheme'>
  >;
  const patch: Partial<User> = {};
  for (const key of ['name', 'phone', 'avatar', 'preferredLanguage', 'preferredTheme'] as const) {
    if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
  }
  const updated = await store().updateUser(req.user!.uid, patch);
  if (!updated) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(updated);
}
