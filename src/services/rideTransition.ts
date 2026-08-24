import { store } from '../models';
import { pushToUser } from './fcmService';
import { sendToUser } from '../websocket/broadcast';
import { nowIso } from '../utils/helpers';
import type { Ride } from '../types';

export type DriverStatus = 'arrived' | 'in_progress' | 'completed';

export type TransitionFailure = 'NO_RIDE' | 'FORBIDDEN' | 'INVALID_TRANSITION';

export type TransitionResult =
  | { ok: true; ride: Ride; changed: boolean }
  | { ok: false; code: TransitionFailure; message: string };

// What a ride may become next. Anything not listed is refused, so a client
// that has fallen behind cannot drag a ride backwards.
const NEXT: Record<string, DriverStatus[]> = {
  assigned: ['arrived'],
  arrived: ['in_progress'],
  in_progress: ['completed'],
};

const NOTIFICATION: Record<DriverStatus, [string, string]> = {
  arrived: ['Driver arrived', 'Your driver is waiting at the pickup point.'],
  in_progress: ['Ride started', 'Enjoy your trip!'],
  completed: ['Ride complete', 'Please rate your driver.'],
};

/**
 * Move a ride to its next state on the driver's say-so.
 *
 * Shared by the WebSocket handler and the REST endpoint so the two can never
 * drift on who is allowed to do what — the socket path is kept only for older
 * clients, and REST is what a driver's phone should be using: it answers, so
 * the app cannot advance its own screen on a message the server never received.
 *
 * **Asking for the state the ride is already in succeeds.** That is the whole
 * point of doing this over REST: a request that times out has to be safe to
 * repeat, and a retry that came back "cannot transition from completed to
 * completed" would leave the driver staring at a failure for something that
 * worked. `changed` says whether this call is the one that moved it.
 */
export async function transitionRide(
  uid: string,
  rideId: string,
  status: DriverStatus
): Promise<TransitionResult> {
  const ride = await store().getRide(rideId);
  if (!ride) return { ok: false, code: 'NO_RIDE', message: 'Ride not found' };
  if (ride.driverId !== uid) return { ok: false, code: 'FORBIDDEN', message: 'Not your ride' };

  if (ride.status === status) return { ok: true, ride, changed: false };

  if (!(NEXT[ride.status] ?? []).includes(status)) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      message: `Cannot transition from ${ride.status} to ${status}`,
    };
  }

  const updated =
    (await store().updateRide(rideId, {
      status,
      // Stamp arrival so cancellation can grant the free grace window.
      ...(status === 'arrived' ? { arrivedAt: nowIso() } : {}),
    })) ?? ride;

  const event = { type: 'ride_status_update', rideId, status, data: {} };
  sendToUser(updated.passengerId, event);
  if (updated.driverId) sendToUser(updated.driverId, event);

  const [title, body] = NOTIFICATION[status];
  await pushToUser(updated.passengerId, title, body, { rideId, status });

  return { ok: true, ride: updated, changed: true };
}
