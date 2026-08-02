import { store } from '../models';
import type { Ride } from '../types';

// A late-cancellation fee the passenger still owes, or null. The create-ride
// gate and the "pay it now" endpoint both ask through here so they cannot
// disagree about what is owed — one refusing an order the other says is clear.
//
// Only cancelled rides can carry one, and only the passenger owes it: the fee
// exists to compensate the driver, so a driver looking at their own cancelled
// ride is owed nothing. listRidesByUser matches either side of the ride, hence
// the passengerId check.
//
// Scanning the most recent page is enough. A fee blocks new bookings the moment
// it is raised, so the only cancellations that can pile up on top of one are
// rides already booked before it — a handful at most, against MAX_PENDING
// scheduled rides.
const SCAN_LIMIT = 100;

export async function findOutstandingFee(uid: string): Promise<Ride | null> {
  const { rides } = await store().listRidesByUser(uid, 'cancelled', 1, SCAN_LIMIT);
  return (
    rides.find(
      (r) =>
        r.passengerId === uid &&
        r.cancellationFeeStatus === 'outstanding' &&
        (r.cancellationFee ?? 0) > 0
    ) ?? null
  );
}
