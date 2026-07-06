import { store } from '../models';
import { broadcast, sendToUser } from '../websocket/broadcast';
import { logger } from '../utils/logger';

const SEARCH_TIMEOUT_MS = 15 * 60 * 1000;

export function startScheduler(intervalMs = 30_000): ReturnType<typeof setInterval> {
  const tick = async (): Promise<void> => {
    try {
      const now = Date.now();

      // Promote scheduled rides whose time has arrived.
      const scheduled = await store().listAllRides('scheduled');
      for (const ride of scheduled) {
        if (ride.scheduledAt && new Date(ride.scheduledAt).getTime() <= now) {
          const updated = await store().updateRide(ride.id, { status: 'searching' });
          broadcast({ type: 'ride_available', ride: updated ?? ride }, 'driver');
          logger.info('[Scheduler] dispatched scheduled ride', { rideId: ride.id });
        }
      }

      // Auto-cancel rides stuck in 'searching' for too long.
      const searching = await store().listAllRides('searching');
      for (const ride of searching) {
        if (now - new Date(ride.createdAt).getTime() > SEARCH_TIMEOUT_MS) {
          const updated = await store().updateRide(ride.id, {
            status: 'cancelled',
          });
          sendToUser(ride.passengerId, {
            type: 'ride_status_update',
            rideId: ride.id,
            status: 'cancelled',
            ride: updated ?? ride,
          });
          logger.info('[Scheduler] auto-cancelled stale ride', { rideId: ride.id });
        }
      }
    } catch (err) {
      logger.warn('[Scheduler] tick failed', { error: (err as Error).message });
    }
  };
  return setInterval(() => void tick(), intervalMs);
}
