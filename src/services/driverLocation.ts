import { store } from '../models';
import { haversineKm } from '../utils/helpers';
import type { GeoPoint } from '../types';

// A driver online reports their position every 30 seconds — over the socket
// *and* over REST, because the socket ping is what keeps the auto-offline sweep
// from parking them. Each of those did a read plus a write, so one driver
// sitting still cost roughly 11,500 reads and 5,800 writes a day: more on their
// own than Firestore's free tier allows, and running that quota out is what
// took the whole API down.
//
// Dispatch never reads the stored copy — it filters on the socket's in-memory
// `driverLocation`, which is still updated on every single ping. What the
// stored copy feeds is the cars drawn on a passenger's map, refreshed every 20
// seconds and only ever approximate. So it is written when the car has actually
// moved, or every couple of minutes regardless, and skipped otherwise.
const PERSIST_EVERY_MS = 2 * 60 * 1000;
const PERSIST_AFTER_KM = 0.15;

const lastPersisted = new Map<string, { at: number; loc: GeoPoint }>();

// Resolves false only when the account is genuinely not a driver — a skipped
// write still answers true, since an entry here can only have been made by a
// write that already proved it.
export async function persistDriverLocation(uid: string, loc: GeoPoint): Promise<boolean> {
  const now = Date.now();
  const prev = lastPersisted.get(uid);
  if (
    prev &&
    now - prev.at < PERSIST_EVERY_MS &&
    haversineKm(prev.loc.lat, prev.loc.lng, loc.lat, loc.lng) < PERSIST_AFTER_KM
  ) {
    return true;
  }
  const user = await store().getUser(uid);
  if (!user?.driverInfo) return false;
  await store().updateUser(uid, {
    driverInfo: { ...user.driverInfo, lastLocation: loc },
  });
  lastPersisted.set(uid, { at: now, loc });
  return true;
}

// Dropped on disconnect and on going offline, so the next shift writes its
// first position immediately instead of inheriting a stale skip window — and so
// this map tracks live drivers rather than every driver the process ever saw.
export function forgetDriverLocation(uid: string): void {
  lastPersisted.delete(uid);
}
