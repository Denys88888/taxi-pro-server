import { store } from '../models';
import type { Ride, RidePaymentStatus } from '../types';

// How far back to look. A passenger with more unpaid rides than this behind
// them is a support case, not a dispatch decision.
const SCAN_LIMIT = 50;

// Payment states that mean the passenger's money has actually left their
// wallet. 'held' is escrow — the fare is ours to release, so the ride is paid
// as far as the passenger is concerned. 'refunded' means it came back to them
// by our decision, so nothing is owed either.
const SETTLED: ReadonlyArray<RidePaymentStatus> = ['held', 'completed', 'refunded'];

/**
 * A finished ride this passenger never paid for, or null.
 *
 * Pi has no card on file. If someone closes the payment sheet after being
 * driven somewhere, there is no second way to charge them — the money is simply
 * gone, and the driver is the one who is out of pocket, since their share is
 * paid out of a fare that never arrived. Refusing the next ride until the last
 * one is settled is the only leverage the app has, and it is the same leverage
 * already used for an unpaid cancellation fee.
 *
 * `pending` counts as unpaid on purpose: a payment that was created and never
 * approved moved nothing.
 */
export async function findUnpaidFare(uid: string): Promise<Ride | null> {
  const { rides } = await store().listRidesByUser(uid, 'completed', 1, SCAN_LIMIT);
  return (
    rides.find(
      (r) =>
        r.passengerId === uid &&
        (r.fare ?? 0) > 0 &&
        !SETTLED.includes(r.paymentStatus as RidePaymentStatus)
    ) ?? null
  );
}
