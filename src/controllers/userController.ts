import type { Request, Response } from 'express';
import { store } from '../models';
import { nowIso } from '../utils/helpers';
import type { User, SavedAddress } from '../types';

// Reconstruct a minimal user record from the verified JWT identity. Used when the
// store has no record yet (e.g. in-memory restart) — the JWT already proves a
// valid Pi-authenticated identity, so we trust uid/role/username from it.
async function ensureUser(req: Request): Promise<User> {
  const existing = await store().getUser(req.user!.uid);
  if (existing) return existing;
  const user: User = {
    uid: req.user!.uid,
    role: req.user!.role,
    name: req.user!.username ?? req.user!.uid,
    rating: 5,
    ratingCount: 0,
    isBlocked: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store().saveUser(user);
  return user;
}

// GET /api/users/me — the authenticated user's own profile.
export async function getMe(req: Request, res: Response): Promise<void> {
  res.json(await ensureUser(req));
}

// PATCH /api/users/me — update editable profile fields (name, phone, avatar,
// language, theme). Avatar is a data URL or hosted URL supplied by the client.
export async function updateMe(req: Request, res: Response): Promise<void> {
  const body = req.body as Partial<
    Pick<User, 'name' | 'phone' | 'avatar' | 'preferredLanguage' | 'preferredTheme'>
  >;
  await ensureUser(req); // create the record if it doesn't exist yet
  const patch: Partial<User> = {};
  for (const key of ['name', 'phone', 'avatar', 'preferredLanguage', 'preferredTheme'] as const) {
    if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
  }
  const updated = await store().updateUser(req.user!.uid, patch);
  res.json(updated);
}

// GET /api/users/me/addresses — the user's saved quick-access places.
export async function getSavedAddresses(req: Request, res: Response): Promise<void> {
  const user = await ensureUser(req);
  res.json({ addresses: user.savedAddresses ?? [] });
}

// PUT /api/users/me/addresses — replace the whole list (client is the source
// of truth; it also mirrors the list to localStorage for offline use).
export async function putSavedAddresses(req: Request, res: Response): Promise<void> {
  const { addresses } = req.body as { addresses: SavedAddress[] };
  await ensureUser(req);
  const updated = await store().updateUser(req.user!.uid, { savedAddresses: addresses });
  res.json({ addresses: updated?.savedAddresses ?? [] });
}
