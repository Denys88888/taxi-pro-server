import { store } from '../models';
import { pushToUser } from './fcmService';
import { sendToUser, broadcast } from '../websocket/broadcast';
import { isApprovedDriver } from '../utils/helpers';
import type { Ride, User } from '../types';

export type AcceptFailure =
  | 'TAKEN'
  | 'NOT_DRIVER'
  | 'BLOCKED'
  | 'NOT_VERIFIED'
  | 'OFFLINE'
  | 'NO_RIDE';

export type AcceptResult =
  | { ok: true; ride: Ride; driverInfo: Record<string, unknown>; changed: boolean }
  | { ok: false; code: AcceptFailure; message: string };

// One accept at a time per ride, within this process. Two drivers tapping the
// same card a few milliseconds apart would otherwise both read 'searching' and
// both write themselves in, and the loser would drive to a passenger who has
// someone else on the way. Render runs a single instance, so a process-local
// lock is enough today; the day there are two, this has to become a conditional
// write in the store.
const accepting = new Set<string>();

function publicDriver(driver: User): Record<string, unknown> {
  return {
    uid: driver.uid,
    name: driver.name,
    phone: driver.phone,
    rating: driver.rating,
    vehicleType: driver.driverInfo?.vehicleType,
    brand: driver.driverInfo?.brand,
    model: driver.driverInfo?.model,
    color: driver.driverInfo?.color,
    number: driver.driverInfo?.number,
    vehiclePhoto: driver.driverInfo?.vehiclePhoto,
  };
}

/**
 * A driver takes an open ride.
 *
 * Shared by the WebSocket handler and the REST endpoint so the eligibility
 * rules — registered, not blocked, verified, on shift — cannot end up
 * different depending on which door the request came through.
 *
 * **A driver re-accepting the ride they already hold succeeds.** Over a socket
 * that never mattered, because nothing could be retried; over HTTP it is the
 * difference between a driver whose request timed out being able to press again
 * and being told the ride was taken — by themselves.
 */
export async function acceptRide(uid: string, rideId: string): Promise<AcceptResult> {
  const driver = await store().getUser(uid);
  if (!driver || driver.role !== 'driver' || !driver.driverInfo) {
    return { ok: false, code: 'NOT_DRIVER', message: 'Not a registered driver' };
  }
  if (driver.isBlocked) return { ok: false, code: 'BLOCKED', message: 'Account blocked' };
  if (!isApprovedDriver(driver.driverInfo)) {
    return { ok: false, code: 'NOT_VERIFIED', message: 'Driver not verified' };
  }
  // Off-shift drivers must not take rides. Nothing clears isOnline during a
  // ride, so this only catches a driver who really did go offline (or was swept
  // offline for GPS silence) and still had a stale card on screen.
  if (!driver.driverInfo.isOnline) {
    return { ok: false, code: 'OFFLINE', message: 'You are offline' };
  }

  // Before taking the lock: a retry of an accept that already succeeded must
  // not collide with itself.
  const existing = await store().getRide(rideId);
  if (!existing) return { ok: false, code: 'NO_RIDE', message: 'Ride not found' };
  if (existing.driverId === uid && existing.status !== 'searching') {
    return { ok: true, ride: existing, driverInfo: publicDriver(driver), changed: false };
  }

  if (accepting.has(rideId)) {
    return { ok: false, code: 'TAKEN', message: 'Ride no longer available' };
  }
  accepting.add(rideId);
  try {
    const ride = await store().getRide(rideId);
    if (!ride) return { ok: false, code: 'NO_RIDE', message: 'Ride not found' };
    if (ride.status !== 'searching') {
      return { ok: false, code: 'TAKEN', message: 'Ride no longer available' };
    }

    const updated =
      (await store().updateRide(rideId, { status: 'assigned', driverId: uid })) ?? ride;
    const driverInfo = publicDriver(driver);

    sendToUser(ride.passengerId, { type: 'ride_assigned', rideId, driverId: uid, driverInfo });
    // Tell the other drivers it is gone, so it leaves their queue.
    broadcast({ type: 'ride_status_update', rideId, status: 'assigned', data: {} }, 'driver');
    await pushToUser(
      ride.passengerId,
      'Driver found!',
      `${driver.name ?? 'Your driver'} is on the way.`,
      { type: 'ride_assigned', rideId }
    );

    return { ok: true, ride: updated, driverInfo, changed: true };
  } finally {
    accepting.delete(rideId);
  }
}
