import { WebSocket } from 'ws';
import type { Role, VehicleType, GeoPoint } from '../types';

// A WebSocket annotated with the authenticated identity and per-connection state.
export interface AuthedSocket extends WebSocket {
  userId?: string;
  role?: Role;
  // Driver's registered vehicle class, kept in sync with driverInfo.vehicleType
  // on connect and on 'driver_online' — lets ride dispatch filter recipients
  // without an async store lookup per online driver per ride request.
  vehicleType?: VehicleType;
  // Driver's last known GPS position; updated on 'driver_online' and every
  // 'driver_location' ping. Used to filter dispatch by distance to pickup
  // so a driver 20km away never gets offered a nearby ride.
  driverLocation?: GeoPoint;
  chatId?: string;
  lastMessageAt?: number;
  isAlive?: boolean;
  // Sliding-window message counter for the generic WS flood guard.
  msgWindowStart?: number;
  msgCount?: number;
  // Timestamp of the last accepted driver_location, for the teleport check and
  // the auto-offline sweep.
  lastLocationAt?: number;
  // True between driver_online and driver_offline — marks a socket the
  // auto-offline heartbeat should watch for GPS silence.
  driverOnline?: boolean;
}

// Live connection registries (transient, per-process).
const userSockets = new Map<string, AuthedSocket>();

export function registerSocket(uid: string, ws: AuthedSocket): void {
  const prev = userSockets.get(uid);
  if (prev && prev !== ws && prev.readyState === WebSocket.OPEN) {
    prev.close(4001, 'replaced');
  }
  userSockets.set(uid, ws);
}

export function unregisterSocket(uid: string, ws: AuthedSocket): void {
  const current = userSockets.get(uid);
  if (current === ws) userSockets.delete(uid);
}

export function send(ws: AuthedSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// Force-close a user's live socket (e.g. when an admin blocks them), after
// optionally delivering a final payload. Code 1008 = policy violation.
export function closeUserSocket(uid: string, finalPayload?: unknown): void {
  const ws = userSockets.get(uid);
  if (!ws) return;
  if (finalPayload && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(finalPayload));
  ws.close(1008, 'Blocked');
  userSockets.delete(uid);
}

// Send to a specific user if they are connected. Returns true if delivered.
export function sendToUser(uid: string, payload: unknown): boolean {
  const ws = userSockets.get(uid);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

// Broadcast to every connected user matching an optional role filter.
export function broadcast(payload: unknown, role?: Role): void {
  const msg = JSON.stringify(payload);
  for (const ws of userSockets.values()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (role && ws.role !== role) continue;
    ws.send(msg);
  }
}

// A comfort/business/xl driver's car is strictly as good as or better than
// an economy request, so they can serve it too — only an economy-registered
// driver is capped to economy-only requests. Comfort/business/xl requests
// stay exact-match (a comfort passenger paying for comfort shouldn't get an
// economy driver's car, and xl specifically needs the extra seats a
// business sedan doesn't have).
function canServe(driverType: VehicleType, requestedType: VehicleType): boolean {
  return driverType === requestedType || requestedType === 'economy';
}

// Haversine great-circle distance in km. Duplicated inline (also in
// utils/helpers) so dispatch stays a single self-contained module.
function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Offer a ride only to online drivers registered for a vehicle class that
// can actually serve it AND (if pickup+radius given) within that radius of
// pickup. Drivers whose location we don't know yet (just came online, no
// ping yet) are included — better to over-notify than to strand a rider on
// a stale/missing coord. Returns the uids actually offered, so the
// scheduler can run an "extended radius" second pass after the offer
// timeout without re-notifying the same drivers.
export function broadcastToDriversOfType(
  payload: unknown,
  vehicleType: VehicleType,
  pickup?: GeoPoint,
  radiusKm?: number,
  excludeUids?: Set<string>
): string[] {
  const msg = JSON.stringify(payload);
  const offered: string[] = [];
  for (const [uid, ws] of userSockets.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.role !== 'driver') continue;
    // Only drivers who are actually on shift. vehicleType alone is set from
    // the stored profile at connect, so without this an off-shift driver with
    // the app merely open collected every ride offer — and could accept one.
    if (ws.driverOnline !== true) continue;
    if (!ws.vehicleType || !canServe(ws.vehicleType, vehicleType)) continue;
    if (excludeUids && excludeUids.has(uid)) continue;
    if (pickup && radiusKm !== undefined && ws.driverLocation) {
      if (distanceKm(ws.driverLocation, pickup) > radiusKm) continue;
    }
    ws.send(msg);
    offered.push(uid);
  }
  return offered;
}

export function onlineUserIds(): string[] {
  return Array.from(userSockets.keys());
}
