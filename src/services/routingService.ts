import fetch from 'cross-fetch';
import { routeDistanceKm } from '../utils/helpers';
import { estimateDurationMin } from './fareCalculator';
import { logger } from '../utils/logger';
import type { GeoPoint } from '../types';

// Road routing via the public OSRM demo server. Fares must reflect the real
// driving distance, not the straight haversine line — otherwise the passenger
// underpays and the driver is short-changed on every ride.

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';
// The demo server has no SLA; never let a slow route lookup stall ride creation.
const TIMEOUT_MS = 5000;

export interface RouteInfo {
  distanceKm: number;
  durationMin: number;
  // True when the values came from OSRM; false for the haversine fallback.
  roadRouted: boolean;
}

// Same waypoints are quoted repeatedly (estimate → create); cache the answers.
const cache = new Map<string, RouteInfo>();

async function queryOsrm(points: GeoPoint[]): Promise<RouteInfo | null> {
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${OSRM_URL}/${coords}?overview=false`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: string;
      routes?: Array<{ distance: number; duration: number }>;
    };
    const route = data.code === 'Ok' && data.routes?.[0];
    if (!route) return null;
    return {
      distanceKm: route.distance / 1000,
      durationMin: Math.max(1, Math.round(route.duration / 60)),
      roadRouted: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Distance + duration along the road network for a pickup → stops… → destination
// path. Falls back to haversine distance and the 30 km/h duration estimate when
// OSRM is unreachable (and always in tests — no network calls there).
export async function getRouteInfo(points: GeoPoint[]): Promise<RouteInfo> {
  const fallback = (): RouteInfo => {
    const distanceKm = routeDistanceKm(points);
    return { distanceKm, durationMin: estimateDurationMin(distanceKm), roadRouted: false };
  };
  if (points.length < 2 || process.env.NODE_ENV === 'test') return fallback();

  const key = points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';');
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const info = await queryOsrm(points);
    if (!info) return fallback();
    if (cache.size > 500) cache.clear();
    cache.set(key, info);
    return info;
  } catch (err) {
    logger.warn('[routing] OSRM lookup failed, falling back to haversine', {
      error: (err as Error).message,
    });
    return fallback();
  }
}
