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

const weatherCache = new Map<string, { wet: boolean; at: number }>();

// Approximate local hour at a point from its longitude (15° per hour). Good
// enough for pricing bands without a timezone database.
function localHour(point?: GeoPoint): number {
  const offset = point ? Math.round(point.lng / 15) : 0;
  return (new Date().getUTCHours() + offset + 24) % 24;
}

function isHoliday(): boolean {
  const d = new Date();
  const md = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return HOLIDAYS.includes(md);
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

export async function getSurge(point?: GeoPoint): Promise<SurgeInfo> {
  // Tests must stay deterministic and offline.
  if (process.env.NODE_ENV === 'test') return { multiplier: 1, reason: 'normal' };

  let best: SurgeInfo = { multiplier: 1, reason: 'normal' };
  const consider = (multiplier: number, reason: SurgeReason) => {
    if (multiplier > best.multiplier) best = { multiplier, reason };
  };

  const hour = localHour(point);
  if (hour >= 7 && hour < 10) consider(PEAK_MULTIPLIER, 'peak');
  if (hour >= 17 && hour < 20) consider(PEAK_MULTIPLIER, 'peak');
  if (hour >= 22 || hour < 6) consider(NIGHT_MULTIPLIER, 'night');
  if (isHoliday()) consider(NIGHT_MULTIPLIER, 'holiday');
  if (point && best.multiplier < WEATHER_MULTIPLIER && (await isWet(point))) {
    consider(WEATHER_MULTIPLIER, 'weather');
  }
  return best;
}
