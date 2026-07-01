import { store } from '../models';
import { broadcast } from '../websocket/broadcast';
import { logger } from '../utils/logger';

// Periodically promotes scheduled rides to 'searching' once their time arrives,
// then broadcasts them to drivers — the same path an immediate request takes.
export function startScheduler(intervalMs = 30_000): ReturnType<typeof setInterval> {
  const tick = async (): Promise<void> => {
    try {
      const scheduled = await store().listAllRides('scheduled');
      const now = Date.now();
      for (const ride of scheduled) {
        if (ride.scheduledAt && new Date(ride.scheduledAt).getTime() <= now) {
          const updated = await store().updateRide(ride.id, { status: 'searching' });
          broadcast({ type: 'ride_available', ride: updated ?? ride }, 'driver');
          logger.info('[Scheduler] dispatched scheduled ride', { rideId: ride.id });
        }
      }
    } catch (err) {
      logger.warn('[Scheduler] tick failed', { error: (err as Error).message });
    }
  };
  return setInterval(() => void tick(), intervalMs);
}
