import { WebSocket } from 'ws';
import type { Role } from '../types';

// A WebSocket annotated with the authenticated identity and per-connection state.
export interface AuthedSocket extends WebSocket {
  userId?: string;
  role?: Role;
  chatId?: string;
  lastMessageAt?: number;
  isAlive?: boolean;
}

// Live connection registries (transient, per-process).
const userSockets = new Map<string, AuthedSocket>();

export function registerSocket(uid: string, ws: AuthedSocket): void {
  userSockets.set(uid, ws);
}

export function unregisterSocket(uid: string): void {
  const current = userSockets.get(uid);
  if (current && (current.userId === uid)) userSockets.delete(uid);
}

export function send(ws: AuthedSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
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

export function onlineUserIds(): string[] {
  return Array.from(userSockets.keys());
}
