import type { Server as HttpServer } from 'http';
import { WebSocketServer } from 'ws';
import { URL } from 'url';
import { verifyToken } from '../utils/jwt';
import { store } from '../models';
import { logger } from '../utils/logger';
import { handleMessage } from './handlers';
import {
  registerSocket,
  unregisterSocket,
  send,
  type AuthedSocket,
} from './broadcast';

const HEARTBEAT_MS = 30_000;
// An online driver with no GPS update for this long is auto-set offline.
const DRIVER_GPS_TIMEOUT_MS = 5 * 60 * 1000;

// Attach a WebSocket server to the existing HTTP server. Authentication happens
// at the handshake via the Sec-WebSocket-Protocol header (`jwt, <token>`), which
// — unlike a ?token= query string — is not written to access logs by proxies,
// CDNs or Render itself. The query string is still accepted so clients running
// an older cached bundle keep working; drop it once those have rolled over.
// An invalid or missing token closes the socket with code 1008.
export function initWebSocket(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    // Echo back only the 'jwt' marker, never the token itself.
    handleProtocols: (protocols) => (protocols.has('jwt') ? 'jwt' : false),
  });

  wss.on('connection', async (socket, req) => {
    const ws = socket as AuthedSocket;
    let token: string | null = null;
    // Preferred: Sec-WebSocket-Protocol: jwt, <token>
    const proto = req.headers['sec-websocket-protocol'];
    if (proto) {
      const parts = (Array.isArray(proto) ? proto.join(',') : proto)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts[0] === 'jwt' && parts[1]) token = parts[1];
    }
    // Legacy fallback: ?token= in the URL.
    if (!token) {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        token = url.searchParams.get('token');
      } catch {
        token = null;
      }
    }

    const payload = verifyToken(token ?? undefined);
    if (!payload) {
      send(ws, { type: 'auth_error', message: 'Invalid or missing token' });
      ws.close(1008, 'Unauthorized');
      return;
    }

    // Reject sockets from users blocked after login (positive check only).
    // Also prefer the CURRENT role from the store over the token claim — a
    // driver approved after login otherwise keeps a stale 'passenger' role and
    // never receives ride_available broadcasts until they re-login.
    let role = payload.role;
    let vehicleType;
    try {
      const user = await store().getUser(payload.uid);
      if (user?.isBlocked) {
        send(ws, { type: 'error', message: 'Account blocked', code: 'BLOCKED' });
        ws.close(1008, 'Blocked');
        return;
      }
      if (user) role = user.role;
      vehicleType = user?.driverInfo?.vehicleType;
    } catch {
      /* store unavailable — fall through on the valid token */
    }

    ws.userId = payload.uid;
    ws.role = role;
    ws.vehicleType = vehicleType;
    ws.isAlive = true;
    registerSocket(payload.uid, ws);
    send(ws, { type: 'authenticated', userId: payload.uid, role });
    logger.info('[WS] connected', { uid: payload.uid, role });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', message: 'Malformed JSON', code: 'BAD_JSON' });
        return;
      }
      try {
        await handleMessage(ws, msg);
      } catch (err) {
        logger.warn('[WS] handler error', {
          type: msg.type,
          error: (err as Error).message,
        });
        send(ws, { type: 'error', message: 'Message handling failed', code: 'HANDLER' });
      }
    });

    ws.on('close', () => {
      unregisterSocket(payload.uid, ws);
      logger.info('[WS] disconnected', { uid: payload.uid });
    });

    ws.on('error', (err) => {
      logger.warn('[WS] socket error', { uid: payload.uid, error: err.message });
    });
  });

  // Heartbeat: terminate connections that stop responding to pings.
  const interval = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      const ws = client as AuthedSocket;
      // Auto-offline: an online driver whose GPS has gone silent for too long
      // (app backgrounded/killed, connection wedged but not yet dropped, phone
      // asleep) is still shown as available and keeps getting ride offers they
      // can't answer. Flip them offline so dispatch stops routing to them.
      if (
        ws.driverOnline &&
        ws.isAlive !== false &&
        now - (ws.lastLocationAt ?? 0) > DRIVER_GPS_TIMEOUT_MS
      ) {
        ws.driverOnline = false;
        void (async () => {
          try {
            const u = await store().getUser(ws.userId!);
            if (u?.driverInfo?.isOnline) {
              await store().updateUser(ws.userId!, {
                driverInfo: { ...u.driverInfo, isOnline: false },
              });
            }
          } catch {
            /* best effort — the socket-level flag is already flipped */
          }
        })();
        send(ws, { type: 'ride_status_update', rideId: '', status: 'offline', data: { reason: 'gps_timeout' } });
        logger.info('[WS] auto-offline (GPS silent)', { uid: ws.userId });
      }
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(interval));

  return wss;
}
