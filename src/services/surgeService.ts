import fetch from 'cross-fetch';
import { logger } from '../utils/logger';
import type { GeoPoint } from '../types';

// Dynamic (surge) pricing. The multiplier is the strongest applicable condition:
//   1.0 normal · 1.3 peak hours · 1.5 rain/snow at pickup · 2.0 night/holiday.
// Weather comes from the free open-meteo API (no key); any failure just means
// the weather component is skipped — pricing must never depend on a third party.

export type SurgeReason = 'normal' | 'peak' | 'weather' | 'night' | 'holiday';

export interface SurgeInfo {
  multiplier: number;
  reason: SurgeReason;
}

const PEAK_MULTIPLIER = 1.3;
const WEATHER_MULTIPLIER = 1.5;
const NIGHT_MULTIPLIER = 2.0;
const WEATHER_TIMEOUT_MS = 3000;
const WEATHER_CACHE_MS = 10 * 60 * 1000;

// Fixed-date public holidays (month-day). Kept minimal and locale-neutral.
const HOLIDAYS = ['01-01', '12-25', '12-31'];

// Beyond this, `at` is treated as a booking rather than as "now" — see the
// weather note in getSurge.
const WEATHER_LOOKAHEAD_MS = 30 * 60 * 1000;

const weatherCache = new Map<string, { wet: boolean; at: number }>();

// The wall clock at the pickup point, approximated from longitude (15° per
// hour) — good enough for pricing bands without a timezone database. Shifting
// the instant rather than just the hour keeps the calendar date in step, which
// the holiday check below reads.
function localClock(point: GeoPoint | undefined, at: Date): Date {
  const offsetHours = point ? Math.round(point.lng / 15) : 0;
  return new Date(at.getTime() + offsetHours * 60 * 60 * 1000);
}

function isHoliday(local: Date): boolean {
  const md = `${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
  return HOLIDAYS.includes(md);
}

// The part of the multiplier that is knowable in advance: what time it will be
// where the passenger is standing when the car actually comes. Exported so the
// bands can be tested without reaching for the network.
export function timeBandSurge(point: GeoPoint | undefined, at: Date): SurgeInfo {
  const local = localClock(point, at);
  const hour = local.getUTCHours();
  let best: SurgeInfo = { multiplier: 1, reason: 'normal' };
  const consider = (multiplier: number, reason: SurgeReason) => {
    if (multiplier > best.multiplier) best = { multiplier, reason };
  };
  if (hour >= 7 && hour < 10) consider(PEAK_MULTIPLIER, 'peak');
  if (hour >= 17 && hour < 20) consider(PEAK_MULTIPLIER, 'peak');
  if (hour >= 22 || hour < 6) consider(NIGHT_MULTIPLIER, 'night');
  if (isHoliday(local)) consider(NIGHT_MULTIPLIER, 'holiday');
  return best;
}

// True when it is currently raining or snowing at the point.
async function isWet(point: GeoPoint): Promise<boolean> {
  const key = `${point.lat.toFixed(1)},${point.lng.toFixed(1)}`;
  const cached = weatherCache.get(key);
  if (cached && Date.now() - cached.at < WEATHER_CACHE_MS) return cached.wet;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${point.lat.toFixed(3)}` +
      `&longitude=${point.lng.toFixed(3)}&current=precipitation,snowfall`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    const data = (await res.json()) as {
      current?: { precipitation?: number; snowfall?: number };
    };
    const wet = (data.current?.precipitation ?? 0) > 0.1 || (data.current?.snowfall ?? 0) > 0;
    weatherCache.set(key, { wet, at: Date.now() });
    return wet;
  } catch (err) {
    logger.warn('[surge] weather lookup failed, skipping', { error: (err as Error).message });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// `at` is when the ride will actually happen. It defaults to now, which is
// right for an immediate order, but a booking has to be priced by its own
// clock: the fare is frozen the moment the passenger books, and pricing a
// 2 p.m. trip by the 11 p.m. night band because that is when they happened to
// tap "book" doubled the fare of a perfectly ordinary afternoon ride.
export async function getSurge(point?: GeoPoint, at: Date = new Date()): Promise<SurgeInfo> {
  // Tests must stay deterministic and offline. timeBandSurge covers the bands.
  if (process.env.NODE_ENV === 'test') return { multiplier: 1, reason: 'normal' };

  const best = timeBandSurge(point, at);

  // Weather is a fact only for a ride happening now. For a booking it is a
  // forecast that may change a dozen times before the car arrives, and since
  // the fare is locked in on the spot, a 50% wet-weather premium charged today
  // for rain that never falls tomorrow is a price nobody agreed to. The
  // time-of-day bands above are knowable in advance, so those still apply.
  const isBooking = at.getTime() - Date.now() > WEATHER_LOOKAHEAD_MS;
  if (!isBooking && point && best.multiplier < WEATHER_MULTIPLIER && (await isWet(point))) {
    return { multiplier: WEATHER_MULTIPLIER, reason: 'weather' };
  }
  return best;
}
