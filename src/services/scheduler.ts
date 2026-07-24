import { store } from '../models';
import { broadcastToDriversOfType, sendToUser } from '../websocket/broadcast';
import { logger } from '../utils/logger';

const SEARCH_TIMEOUT_MS = 15 * 60 * 1000;
const ASSIGNED_TIMEOUT_MS = 15 * 60 * 1000;
const ARRIVED_TIMEOUT_MS = 30 * 60 * 1000;
const IN_PROGRESS_TIMEOUT_MS = 3 * 60 * 60 * 1000;

export function startScheduler(intervalMs = 30_000): ReturnType<typeof setInterval> {
  const tick = async (): Promise<void> => {
    try {
      const now = Date.now();

      // Promote scheduled rides whose time has arrived.
      const scheduled = await store().listAllRides('scheduled');
      for (const ride of scheduled) {
        try {
          if (ride.scheduledAt && new Date(ride.scheduledAt).getTime() <= now) {
            const updated = await store().updateRide(ride.id, { status: 'searching' });
            broadcastToDriversOfType({ type: 'ride_available', ride: updated ?? ride }, ride.vehicleType);
            logger.info('[Scheduler] dispatched scheduled ride', { rideId: ride.id });
          }
        } catch (e) {
          logger.warn('[Scheduler] failed to promote ride', { rideId: ride.id, error: (e as Error).message });
        }
      }

      // Auto-cancel rides stuck in 'searching' for too long.
      const searching = await store().listAllRides('searching');
      for (const ride of searching) {
        try {
          if (now - new Date(ride.createdAt).getTime() > SEARCH_TIMEOUT_MS) {
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
        const rides = await store().listAllRides(status);
        for (const ride of rides) {
          try {
            if (now - new Date(ride.updatedAt ?? ride.createdAt).getTime() > timeout) {
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
      const inProgress = await store().listAllRides('in_progress');
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
