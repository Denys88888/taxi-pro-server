import { FARE_TABLE } from '../config/constants';
import { round } from '../utils/helpers';
import type { VehicleType } from '../types';

export interface FareBreakdown {
  fare: number;
  platformFeePercent: number;
  platformFee: number;
  driverEarnings: number;
}

// total = (base + km*perKm + min*perMin) * surge, floored at the vehicle minFare.
// Platform fee is a percentage of the fare; the driver keeps the remainder.
// Admin settings can raise the global minimum fare and rescale the per-km rate
// (baseFarePerKm is the economy rate; other classes keep their ratio to it).
export function calculateFare(params: {
  vehicleType: VehicleType;
  distanceKm: number;
  durationMin: number;
  surge?: number;
  platformFeePercent: number;
  minFare?: number;
  baseFarePerKm?: number;
}): FareBreakdown {
  const { vehicleType, distanceKm, durationMin, platformFeePercent } = params;
  const surge = params.surge && params.surge > 0 ? params.surge : 1;
  const table = FARE_TABLE[vehicleType] ?? FARE_TABLE.economy;

  const perKmScale =
    params.baseFarePerKm && params.baseFarePerKm > 0
      ? params.baseFarePerKm / FARE_TABLE.economy.perKm
      : 1;
  const minFare = Math.max(table.minFare, params.minFare ?? 0);

  const raw =
    (table.base + distanceKm * table.perKm * perKmScale + durationMin * table.perMin) * surge;
  const fare = round(Math.max(raw, minFare));

  const platformFee = round((fare * platformFeePercent) / 100);
  const driverEarnings = round(fare - platformFee);

  return { fare, platformFeePercent, platformFee, driverEarnings };
}

// Rough duration estimate from distance, assuming ~30 km/h urban average.
export function estimateDurationMin(distanceKm: number): number {
  return Math.max(1, Math.round((distanceKm / 30) * 60));
}
