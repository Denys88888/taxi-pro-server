import type { Request, Response } from 'express';
import { store } from '../models';
import { fetchTurnIceServers } from '../services/turnCredentials';
import { CALLABLE_RIDE_STATUSES } from '../services/activeRide';
import type { RideStatus } from '../types';

// A fresh TURN credential per request — call setup is infrequent (once per
// ride call, not per ICE candidate), so there's no meaningful cost to not
// caching it, and it keeps every credential's lifetime tied to a real call.
//
// Gated on the caller actually being on a ride they could place a call during,
// mirroring the WebSocket call_offer check exactly (both read
// CALLABLE_RIDE_STATUSES). Without this the endpoint minted a working one-hour
// relay credential for anyone with a token and no ride at all — and since
// /api/auth/dev hands out tokens to anyone while PI_SANDBOX is on, that is
// effectively the public internet draining the 500 MB monthly relay quota that
// real calls depend on.
export async function getTurnCredentials(req: Request, res: Response): Promise<void> {
  const rideId = typeof req.query.rideId === 'string' ? req.query.rideId : '';
  if (!rideId) {
    res.status(400).json({ error: 'rideId is required' });
    return;
  }
  const ride = await store().getRide(rideId);
  const uid = req.user!.uid;
  if (!ride || (ride.passengerId !== uid && ride.driverId !== uid)) {
    res.status(403).json({ error: 'Not a participant of this ride' });
    return;
  }
  if (!CALLABLE_RIDE_STATUSES.includes(ride.status as RideStatus)) {
    res.status(409).json({ error: 'Ride is not in a callable state', code: 'RIDE_INACTIVE' });
    return;
  }
  const iceServers = (await fetchTurnIceServers()) ?? [];
  res.json({ iceServers });
}
