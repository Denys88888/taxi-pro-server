import type { VehicleType, Settings } from '../types';

// Pi Platform API host (same host for testnet + mainnet; sandbox flag governs behaviour).
export const PI_API_HOST = 'api.minepi.com';

// JWT lifetime.
export const JWT_EXPIRY = '24h';
export const SHARE_TOKEN_EXPIRY = '4h';

// Ride matching.
export const DEFAULT_SEARCH_RADIUS_KM = 5;
export const EXTENDED_SEARCH_RADIUS_KM = 10;
export const DRIVER_OFFER_TIMEOUT_MS = 30_000;

// Fare model. total = (base + km * perKm + min * perMin) * surge, floored at minFare.
export const FARE_TABLE: Record<
  VehicleType,
  { base: number; perKm: number; perMin: number; minFare: number }
> = {
  economy: { base: 1.0, perKm: 0.5, perMin: 0.1, minFare: 1.5 },
  comfort: { base: 1.5, perKm: 0.7, perMin: 0.12, minFare: 2.0 },
  business: { base: 2.5, perKm: 1.0, perMin: 0.18, minFare: 3.5 },
  xl: { base: 2.0, perKm: 0.9, perMin: 0.15, minFare: 3.0 },
};

// Cancellation fee after the driver has arrived (fraction of fare).
export const LATE_CANCELLATION_FEE_PERCENT = 50;

// Minimum requirements to register for each vehicle class — self-reported at
// signup, checked here so a driver can't just pick "business" for the higher
// fare with an old/small car; the admin review (which sees the photos) is
// the final backstop against an outright lie. `minSeats` only applies to xl
// (a bigger vehicle, not necessarily a newer one).
export const VEHICLE_CLASS_REQUIREMENTS: Record<
  VehicleType,
  { minYear: number; minSeats?: number }
> = {
  economy: { minYear: 2000 },
  comfort: { minYear: currentYearMinus(10) },
  xl: { minYear: currentYearMinus(12), minSeats: 6 },
  business: { minYear: currentYearMinus(6) },
};

function currentYearMinus(years: number): number {
  return new Date().getFullYear() - years;
}

// Global defaults, overridable by admins via the settings doc.
export const DEFAULT_SETTINGS: Settings = {
  platformFeePercent: 10,
  surgeEnabled: true,
  minFare: FARE_TABLE.economy.minFare,
  baseFarePerKm: FARE_TABLE.economy.perKm,
  appName: 'Taxi Pro',
  appLogo: '/icons/icon-512.png',
  contactEmail: 'support@taxipro.app',
  maintenanceMode: false,
  maxSearchRadiusKm: DEFAULT_SEARCH_RADIUS_KM,
  extendedSearchRadiusKm: EXTENDED_SEARCH_RADIUS_KM,
  minDriverRating: 3.0,
  autoBlockThreshold: 5,
  updatedAt: new Date(0).toISOString(),
  updatedBy: 'system',
};

export const MAX_MESSAGE_LENGTH = 500;
