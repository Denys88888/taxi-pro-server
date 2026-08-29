import type { Request, Response } from 'express';
import { fetchTurnIceServers } from '../services/turnCredentials';

// A fresh TURN credential per request — call setup is infrequent (once per
// ride call, not per ICE candidate), so there's no meaningful cost to not
// caching it, and it keeps every credential's lifetime tied to a real call.
export async function getTurnCredentials(_req: Request, res: Response): Promise<void> {
  const iceServers = (await fetchTurnIceServers()) ?? [];
  res.json({ iceServers });
}
