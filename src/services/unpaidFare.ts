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
 * The passenger's last ride, if they never paid for it. Otherwise null.
 *
 * Pi has no card on file. If someone closes the payment sheet after being
 * driven somewhere, there is no second way to charge them — the money is simply
 * gone, and the driver is the one out of pocket, since their share is paid out
 * of a fare that never arrived. Refusing the next ride until the last one is
 * settled is the only leverage the app has, and it is the same leverage already
 * used for an unpaid cancellation fee.
 *
 * **Only the most recent ride is examined, deliberately.** Checking every
 * unpaid ride ever turned this into whack-a-mole: the owner paid the ride the
 * refusal named, ordered again, and was refused over the one behind it. In
 * normal running a backlog cannot form — an unpaid ride blocks the next order,
 * so there is never a second one to go unpaid — and a pile can only exist from
 * before this rule was introduced, which is exactly what happened here. Making
 * someone pay off months of test rides one refusal at a time is not a debt
 * policy, it is a lockout.
 *
 * `pending` and `cancelled` count as unpaid on purpose: a payment row created
 * and never approved moved nothing. `held` does not — escrow means the money
 * has already left the passenger's wallet and is ours to release.
 */
export async function findUnpaidFare(uid: string): Promise<Ride | null> {
  const { rides } = await store().listRidesByUser(uid, 'completed', 1, SCAN_LIMIT);
  // Both stores return newest first. Rides this user drove come back from the
  // same query; charging a driver for having driven would be absurd.
  const asPassenger = rides.filter((r) => r.passengerId === uid && (r.fare ?? 0) > 0);
  const last = asPassenger[0];
  if (!last) return null;
  return SETTLED.includes(last.paymentStatus as RidePaymentStatus) ? null : last;
}
