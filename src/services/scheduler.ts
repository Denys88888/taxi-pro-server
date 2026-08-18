import { store } from '../models';
import type { Ride, RideStatus } from '../types';
import { nowIso } from '../utils/helpers';
import { broadcastToDriversOfType, sendToUser } from '../websocket/broadcast';
import { releaseHeldPayment } from '../controllers/paymentController';
import { pushToUser } from './fcmService';
import { logger } from '../utils/logger';
import { DRIVER_OFFER_TIMEOUT_MS, SCHEDULED_DISPATCH_GRACE_MS } from '../config/constants';
import { hasLiveRide } from './activeRide';

const SEARCH_TIMEOUT_MS = 15 * 60 * 1000;
const ASSIGNED_TIMEOUT_MS = 15 * 60 * 1000;
const ARRIVED_TIMEOUT_MS = 30 * 60 * 1000;
const IN_PROGRESS_TIMEOUT_MS = 3 * 60 * 60 * 1000;

// Rides that got the first-pass radius broadcast but not yet the extended
// one — tracked per-process so the scheduler doesn't spam the extended
// broadcast every tick until someone accepts.
const expandedRadiusFired = new Set<string>();

// UIDs of drivers already offered a given ride in the first (narrow-radius)
// pass, so the extended-radius pass doesn't re-notify them a second time.
// Populated by rideController/handlers when they dispatch, read here.
export const initialOffered = new Map<string, Set<string>>();

export function startScheduler(intervalMs = 30_000): ReturnType<typeof setInterval> {
  const tick = async (): Promise<void> => {
    try {
      const now = Date.now();

      const settings = await store().getSettings();

      // One query for every status this tick touches. Firestore bills a read per
      // query even when it matches nothing, so five separate polls twice a
      // minute cost ~14k reads a day on an idle app — enough on their own to
      // exhaust the free tier's 50k and take the API down with a quota error.
      const live = await store().listAllRides([
        'scheduled',
        'searching',
        'assigned',
        'arrived',
        'in_progress',
      ]);
      const byStatus = (s: RideStatus): Ride[] => live.filter((r) => r.status === s);

      // Promote scheduled rides whose time has arrived — same distance
      // filter as immediate rides.
      const scheduled = byStatus('scheduled');
      for (const ride of scheduled) {
        try {
          if (ride.scheduledAt && new Date(ride.scheduledAt).getTime() <= now) {
            // Never dispatch a booking to a passenger who is already riding:
            // two live rides at once puts two drivers on one person and leaves
            // the passenger's screen with no single ride to track. It waits
            // instead, and goes out on the first tick after they're free.
            if (await hasLiveRide(ride.passengerId)) {
              const overdue = now - new Date(ride.scheduledAt).getTime();
              if (overdue > SCHEDULED_DISPATCH_GRACE_MS) {
                // Their current trip outlasted the grace period. Sending a car
                // an hour after the booked time is worse than not sending one,
                // so the booking is dropped and the passenger told.
                const updated = await store().updateRide(ride.id, { status: 'cancelled' });
                sendToUser(ride.passengerId, {
                  type: 'ride_status_update',
                  rideId: ride.id,
                  status: 'cancelled',
                  ride: updated ?? ride,
                });
                logger.info('[Scheduler] dropped booking that never got a free slot', {
                  rideId: ride.id,
                });
              }
              continue;
            }
            const updated = await store().updateRide(ride.id, {
              status: 'searching',
              searchStartedAt: nowIso(),
            });
            const offered = broadcastToDriversOfType(
              { type: 'ride_available', ride: updated ?? ride },
              ride.vehicleType,
              ride.pickup,
              settings.maxSearchRadiusKm
            );
            initialOffered.set(ride.id, new Set(offered));
            logger.info('[Scheduler] dispatched scheduled ride', { rideId: ride.id });
          }
        } catch (e) {
          logger.warn('[Scheduler] failed to promote ride', { rideId: ride.id, error: (e as Error).message });
        }
      }

      // Auto-cancel rides stuck in 'searching' for too long, AND expand the
      // search radius once (after DRIVER_OFFER_TIMEOUT_MS) for those still
      // waiting — a first-pass radius that turned up no takers doesn't mean
      // the ride is a lost cause, just that the closest drivers aren't
      // biting.
      const searching = byStatus('searching');
      // Purge tracked-expanded ids for rides no longer in 'searching' (took
      // an offer, was cancelled, whatever) — otherwise this Set grows
      // unbounded across the process lifetime for every ride that ever
      // triggered an expansion, since the delete on the auto-cancel branch
      // only catches the tiny minority of rides that time out entirely.
      const stillSearching = new Set(searching.map((r) => r.id));
      for (const id of expandedRadiusFired) {
        if (!stillSearching.has(id)) expandedRadiusFired.delete(id);
      }
      for (const id of initialOffered.keys()) {
        if (!stillSearching.has(id)) initialOffered.delete(id);
      }
      for (const ride of searching) {
        try {
          // Age from when the search actually began, never from createdAt —
          // for a scheduled ride createdAt is when the passenger booked it,
          // which can be hours or days earlier. searchStartedAt is stamped the
          // moment a ride enters 'searching'; rides created before that field
          // existed fall back to updatedAt (refreshed by the promotion).
          const searchStartedAt = new Date(
            ride.searchStartedAt ?? ride.updatedAt ?? ride.createdAt
          ).getTime();
          const age = now - searchStartedAt;
          if (
            age > DRIVER_OFFER_TIMEOUT_MS &&
            !expandedRadiusFired.has(ride.id) &&
            settings.extendedSearchRadiusKm > settings.maxSearchRadiusKm
          ) {
            expandedRadiusFired.add(ride.id);
            broadcastToDriversOfType(
              { type: 'ride_available', ride },
              ride.vehicleType,
              ride.pickup,
              settings.extendedSearchRadiusKm,
              initialOffered.get(ride.id)
            );
            logger.info('[Scheduler] expanded radius for waiting ride', {
              rideId: ride.id,
              radiusKm: settings.extendedSearchRadiusKm,
            });
          }
          // Same basis as `age` above. Reading createdAt here meant a ride
          // booked more than SEARCH_TIMEOUT_MS in advance was auto-cancelled
          // on the very next tick after being dispatched — no driver ever got
          // a chance to take it, which broke scheduled rides outright.
          if (age > SEARCH_TIMEOUT_MS) {
            if (ride.paymentStatus === 'held' && ride.paymentId) {
              await releaseHeldPayment(ride.paymentId);
            }
            const updated = await store().updateRide(ride.id, {
              status: 'cancelled',
              paymentStatus: ride.paymentStatus === 'held' ? 'refunded' : 'cancelled',
            });
            sendToUser(ride.passengerId, {
              type: 'ride_status_update',
              rideId: ride.id,
              status: 'cancelled',
              ride: updated ?? ride,
            });
            expandedRadiusFired.delete(ride.id);
            logger.info('[Scheduler] auto-cancelled stale ride', { rideId: ride.id });
          }
        } catch (e) {
          logger.warn('[Scheduler] failed to cancel ride', { rideId: ride.id, error: (e as Error).message });
        }
      }
      // Auto-cancel rides stuck in assigned/arrived (driver never progressed).
      const stuckStatuses = [
        { status: 'assigned' as const, timeout: ASSIGNED_TIMEOUT_MS },
        { status: 'arrived' as const, timeout: ARRIVED_TIMEOUT_MS },
      ];
      for (const { status, timeout } of stuckStatuses) {
        const rides = byStatus(status);
        for (const ride of rides) {
          try {
            if (now - new Date(ride.updatedAt ?? ride.createdAt).getTime() > timeout) {
              if (ride.paymentStatus === 'held' && ride.paymentId) {
                await releaseHeldPayment(ride.paymentId);
              }
              const updated = await store().updateRide(ride.id, {
                status: 'cancelled',
                paymentStatus: ride.paymentStatus === 'held' ? 'refunded' : 'cancelled',
              });
              sendToUser(ride.passengerId, {
                type: 'ride_status_update',
                rideId: ride.id,
                status: 'cancelled',
                ride: updated ?? ride,
              });
              if (ride.driverId) {
                sendToUser(ride.driverId, {
                  type: 'ride_status_update',
                  rideId: ride.id,
                  status: 'cancelled',
                  ride: updated ?? ride,
                });
              }
              logger.info('[Scheduler] auto-cancelled stuck ride', { rideId: ride.id, was: status });
            }
          } catch (e) {
            logger.warn('[Scheduler] failed to cancel stuck ride', { rideId: ride.id, error: (e as Error).message });
          }
        }
      }

      // Flag rides stuck in_progress for too long (possible app crash).
      const inProgress = byStatus('in_progress');
      for (const ride of inProgress) {
        try {
          if (now - new Date(ride.updatedAt ?? ride.createdAt).getTime() > IN_PROGRESS_TIMEOUT_MS) {
            const updated = await store().updateRide(ride.id, { status: 'completed' });
            sendToUser(ride.passengerId, {
              type: 'ride_status_update',
              rideId: ride.id,
              status: 'completed',
              ride: updated ?? ride,
            });
            if (ride.driverId) {
              sendToUser(ride.driverId, {
                type: 'ride_status_update',
                rideId: ride.id,
                status: 'completed',
                ride: updated ?? ride,
              });
            }
            await pushToUser(ride.passengerId, 'Ride complete', 'Your ride has been completed.', { rideId: ride.id, status: 'completed' });
            if (ride.driverId) await pushToUser(ride.driverId, 'Ride complete', 'The ride has been marked as completed.', { rideId: ride.id, status: 'completed' });
            logger.info('[Scheduler] auto-completed stuck ride', { rideId: ride.id });
          }
        } catch (e) {
          logger.warn('[Scheduler] failed to complete stuck ride', { rideId: ride.id, error: (e as Error).message });
        }
      }
    } catch (err) {
      logger.warn('[Scheduler] tick failed', { error: (err as Error).message });
    }
  };
  return setInterval(() => void tick(), intervalMs);
}
