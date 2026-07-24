import { WebSocket } from 'ws';
import type { Role, VehicleType } from '../types';

// A WebSocket annotated with the authenticated identity and per-connection state.
export interface AuthedSocket extends WebSocket {
  userId?: string;
  role?: Role;
  // Driver's registered vehicle class, kept in sync with driverInfo.vehicleType
  // on connect and on 'driver_online' — lets ride dispatch filter recipients
  // without an async store lookup per online driver per ride request.
  vehicleType?: VehicleType;
  chatId?: string;
  lastMessageAt?: number;
  isAlive?: boolean;
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

// Offer a ride only to online drivers registered for a vehicle class that
// can actually serve it — an economy-registered driver must never be able
// to pick up a business/comfort/xl request. Plain role-based broadcast()
// can't express this since it has no notion of vehicle class.
export function broadcastToDriversOfType(payload: unknown, vehicleType: VehicleType): void {
  const msg = JSON.stringify(payload);
  for (const ws of userSockets.values()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.role !== 'driver') continue;
    if (!ws.vehicleType || !canServe(ws.vehicleType, vehicleType)) continue;
    ws.send(msg);
  }
}

export function onlineUserIds(): string[] {
  return Array.from(userSockets.keys());
}
