// Shared domain types for the Taxi Pro backend.

export type Role = 'passenger' | 'driver' | 'admin';

export type VehicleType = 'economy' | 'comfort' | 'business' | 'xl';

export type RideStatus =
  | 'scheduled'
  | 'searching'
  | 'assigned'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

// A driver's price bid on a negotiable (inDriver-style) ride request.
export interface FareOffer {
  driverId: string;
  driverName: string;
  driverRating: number;
  vehicleType?: VehicleType;
  amount: number;
  etaMin?: number;
  createdAt: string;
}

export type PaymentStatus =
  | 'created'
  | 'approved'
  | 'completed'
  | 'cancelled'
  | 'failed';

// Escrow-style lifecycle of the ride's Pi payment as seen on the ride itself:
// pending (not yet initiated) → held (approved, funds reserved) → completed | refunded | cancelled.
export type RidePaymentStatus = 'pending' | 'held' | 'completed' | 'refunded' | 'cancelled';

export interface GeoPoint {
  lat: number;
  lng: number;
  address?: string;
}

// Admin review state of a driver application. Legacy records may lack it:
// fall back to licenseVerified ? 'approved' : 'pending'.
export type DriverApplicationStatus = 'pending' | 'approved' | 'rejected';

export interface DriverInfo {
  vehicleType: VehicleType;
  applicationStatus?: DriverApplicationStatus;
  brand: string;
  model: string;
  color: string;
  number: string;
  vehiclePhoto?: string;
  licensePhoto?: string;
  licenseVerified: boolean;
  isOnline: boolean;
  lastLocation?: GeoPoint;
}

// A user's quick-access saved place ("Home", "Work", "Parents", …).
export interface SavedAddress {
  label: string;
  lat: number;
  lng: number;
  address?: string;
}

export interface User {
  uid: string;
  role: Role;
  name: string;
  email?: string;
  phone?: string;
  avatar?: string;
  rating: number;
  ratingCount: number;
  isBlocked: boolean;
  blockReason?: string;
  fcmToken?: string;
  preferredLanguage?: string;
  preferredTheme?: 'light' | 'dark' | 'auto';
  savedAddresses?: SavedAddress[];
  driverInfo?: DriverInfo;
  createdAt: string;
  updatedAt: string;
}

export interface Ride {
  id: string;
  passengerId: string;
  driverId?: string;
  pickup: GeoPoint;
  destination: GeoPoint;
  // Optional intermediate stops (multi-stop rides), in visiting order.
  stops?: GeoPoint[];
  vehicleType: VehicleType;
  distanceKm: number;
  estimatedDurationMin: number;
  fare: number;
  // Surge multiplier the fare was computed with (1 = normal pricing).
  surgeMultiplier?: number;
  platformFeePercent: number;
  platformFee: number;
  driverEarnings: number;
  // Tip paid to the driver after completion (separate Pi transaction, no fee).
  tipAmount?: number;
  tipTxid?: string;
  paymentStatus?: RidePaymentStatus;
  // A2U payout of the driver's share (fare minus platform fee) out of the app
  // wallet — separate from paymentStatus, which only tracks the passenger's
  // U2A payment into the app wallet.
  driverPayoutStatus?: 'pending' | 'completed' | 'failed';
  driverPayoutTxid?: string;
  driverPayoutError?: string;
  // Pi's payment identifier for a failed attempt — lets an operator cancel
  // the stuck Pi-side payment (via POST /api/admin/pi-payments/:id/cancel)
  // without having to parse it back out of the "ongoing_payment_found" error.
  driverPayoutPiId?: string;
  // A2U payout of a tip (100% to the driver, no platform fee).
  tipPayoutStatus?: 'pending' | 'completed' | 'failed';
  tipPayoutTxid?: string;
  tipPayoutError?: string;
  tipPayoutPiId?: string;
  status: RideStatus;
  // Scheduled rides: ISO time the ride should be dispatched. Absent = immediate.
  scheduledAt?: string;
  // inDriver-style negotiation: passenger's asking price + collected driver bids.
  negotiable?: boolean;
  offeredFare?: number;
  offers?: FareOffer[];
  paymentId?: string;
  txid?: string;
  passengerRating?: number;
  driverRating?: number;
  passengerReview?: string;
  driverReview?: string;
  cancelledBy?: Role;
  cancellationReason?: string;
  cancellationFee?: number;
  shareToken?: string;
  createdAt: string;
  updatedAt: string;
}

// Public-safe view of a ride counterpart, exposed per visibility rules
// (passenger sees driver after assignment; driver sees passenger after accept).
export interface RideParty {
  uid: string;
  name: string;
  phone?: string;
  rating: number;
  avatar?: string;
  vehicleType?: VehicleType;
  brand?: string;
  model?: string;
  color?: string;
  number?: string;
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  senderRole: Role;
  text: string;
  isTemplate: boolean;
  timestamp: string;
}

export interface Payment {
  id: string;
  rideId: string;
  // 'ride' = the fare itself (escrowed); 'tip' = a post-ride tip to the driver.
  type?: 'ride' | 'tip';
  amount: number;
  platformFeePercent: number;
  platformFee: number;
  driverEarnings: number;
  status: PaymentStatus;
  txid?: string;
  piPaymentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PushToken {
  userId: string;
  token: string;
  platform: string;
  updatedAt: string;
}

export interface Report {
  id: string;
  rideId: string;
  reporterId: string;
  reportedId: string;
  reason: string;
  description?: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolvedBy?: string;
  createdAt: string;
}

export interface Settings {
  platformFeePercent: number;
  // Dynamic pricing on/off + fare knobs (admin-tunable).
  surgeEnabled: boolean;
  // Global minimum ride price (π); the per-vehicle table floor still applies.
  minFare: number;
  // Economy per-km rate (π); other vehicle classes scale proportionally.
  baseFarePerKm: number;
  appName: string;
  appLogo: string;
  contactEmail: string;
  maintenanceMode: boolean;
  maxSearchRadiusKm: number;
  extendedSearchRadiusKm: number;
  minDriverRating: number;
  autoBlockThreshold: number;
  updatedAt: string;
  updatedBy: string;
}

export interface JwtPayload {
  uid: string;
  role: Role;
  username?: string;
}
