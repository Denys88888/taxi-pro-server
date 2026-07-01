// Shared domain types for the Taxi Pro backend.

export type Role = 'passenger' | 'driver' | 'admin';

export type VehicleType = 'economy' | 'comfort' | 'business' | 'xl';

export type RideStatus =
  | 'searching'
  | 'assigned'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type PaymentStatus =
  | 'created'
  | 'approved'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface GeoPoint {
  lat: number;
  lng: number;
  address?: string;
}

export interface DriverInfo {
  vehicleType: VehicleType;
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
  vehicleType: VehicleType;
  distanceKm: number;
  estimatedDurationMin: number;
  fare: number;
  platformFeePercent: number;
  platformFee: number;
  driverEarnings: number;
  status: RideStatus;
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
