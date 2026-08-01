import { store } from '../models';
import type { RideStatus } from '../types';

// A ride that is actually under way. Deliberately excludes 'scheduled': a
// booking for later is not a ride in progress, and counting it as one meant a
// passenger who booked a trip for tomorrow could not order a taxi today.
export const LIVE_RIDE_STATUSES: RideStatus[] = [
  'searching',
  'assigned',
  'arrived',
  'in_progress',
];

// Whether this user already has a ride under way. The create-ride gate and the
// dispatcher both ask through here, so they cannot end up disagreeing about
// what "already riding" means — one refusing an order the other would allow.
export async function hasLiveRide(uid: string): Promise<boolean> {
  for (const status of LIVE_RIDE_STATUSES) {
    const { total } = await store().listRidesByUser(uid, status, 1, 1);
    if (total > 0) return true;
  }
  return false;
}
