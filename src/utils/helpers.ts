import crypto from 'crypto';
import type { DriverInfo, DriverApplicationStatus, Ride } from '../types';

// Where a driver's application actually stands. applicationStatus is the field
// of record, but drivers approved before it existed carry only licenseVerified
// — read that as 'approved' so a legacy driver isn't locked out. Anything that
// needs to know the review state reads it from here, never from the raw
// fields, so the answer can't differ between two places in the codebase.
export function driverApprovalStatus(info?: DriverInfo): DriverApplicationStatus {
  if (!info) return 'pending';
  return info.applicationStatus ?? (info.licenseVerified ? 'approved' : 'pending');
}

// A driver may go online, accept rides, bid on them and hold the driver role
// only once an admin has approved them. Every such gate goes through here.
export function isApprovedDriver(info?: DriverInfo): boolean {
  return driverApprovalStatus(info) === 'approved';
}

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

// The platform's share of a collected late-cancellation fee. The ride's own
// platformFee belongs to the fare, and that fare was refunded — the only
// revenue such a ride produces is the part of the fee the driver did not get.
// An outstanding fee is worth nothing until it is actually paid.
export function collectedFeePlatformCut(ride: Ride): number {
  if (ride.cancellationFeeStatus !== 'paid') return 0;
  return Math.max(0, (ride.cancellationFee || 0) - (ride.cancellationFeeDriverEarnings || 0));
}

// What a driver earned from a ride, whether it ran or not: a ride cancelled
// late on them pays their share of the fee and nothing else, since the fare and
// any tip belong to a trip that never happened.
export function driverEarnedFrom(ride: Ride): number {
  if (ride.status === 'cancelled') {
    return ride.cancellationFeeStatus === 'paid' ? ride.cancellationFeeDriverEarnings || 0 : 0;
  }
  return (ride.driverEarnings || 0) + (ride.tipAmount || 0);
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
