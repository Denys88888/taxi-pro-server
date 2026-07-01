import crypto from 'crypto';

// Great-circle distance between two lat/lng points, in kilometres.
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Total path length in km across an ordered list of points (multi-stop routes).
export function routeDistanceKm(points: { lat: number; lng: number }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineKm(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return total;
}

// Round to a fixed number of decimals (default 2), returning a number.
export function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function nowIso(): string {
  return new Date().toISOString();
}

// Prefixed, collision-resistant id (e.g. "ride_lp3k9x_a1b2c3").
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto
    .randomBytes(4)
    .toString('hex')}`;
}

// Deterministic chat id for a ride, so both parties resolve the same room.
export function chatIdForRide(rideId: string): string {
  return `chat_${rideId}`;
}
