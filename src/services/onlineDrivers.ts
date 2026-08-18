import { store } from '../models';
import { TtlCache } from '../utils/ttlCache';
import type { User } from '../types';

// Every passenger with the order screen open asks "which cars are near me?"
// every 20 seconds, and answering means reading the document of every driver
// currently online — there is no radius in the query, the distance filter runs
// in memory afterwards. So the cost of that one screen is passengers × drivers,
// and it is the term that grows fastest as the app fills up: at a hundred
// drivers online it alone outspends everything else in the app combined.
//
// The answer, though, is the same for everybody within a couple of seconds of
// each other, so it is fetched once and shared. What it feeds is the cars drawn
// on a map, refreshed on a 20-second timer and never precise anyway — the
// positions inside it are already deliberately up to two minutes old.
//
// Dispatch does NOT read this. Offering a ride goes through the in-memory
// socket registry, which is exact and updated on every single ping, so no
// staleness here can misroute a ride or hide one from a driver.
const ONLINE_DRIVERS_TTL_MS = 15_000;
const KEY = 'all';

const cache = new TtlCache<User[]>(ONLINE_DRIVERS_TTL_MS, 1);

export function listOnlineDriversCached(): Promise<User[]> {
  return cache.get(KEY, () => store().listOnlineDrivers());
}

// Called wherever a driver's online flag flips, so a car appears on the
// passenger's map the moment its driver starts a shift and vanishes when they
// end one, instead of lingering for the rest of the TTL.
export function forgetOnlineDrivers(): void {
  cache.invalidate(KEY);
}
