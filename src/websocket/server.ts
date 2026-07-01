import type { Server as HttpServer } from 'http';
import { WebSocketServer } from 'ws';
import { URL } from 'url';
import { verifyToken } from '../utils/jwt';
import { logger } from '../utils/logger';
import { handleMessage } from './handlers';
import {
  registerSocket,
  unregisterSocket,
  send,
  type AuthedSocket,
} from './broadcast';

const HEARTBEAT_MS = 30_000;

// Attach a WebSocket server to the existing HTTP server. Authentication happens
// at the handshake: the client connects to wss://host/?token=<jwt>. An invalid or
// missing token closes the socket with code 1008 (policy violation).
export function initWebSocket(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket, req) => {
    const ws = socket as AuthedSocket;
    let token: string | null = null;
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      token = url.searchParams.get('token');
    } catch {
      token = null;
    }

    const payload = verifyToken(token ?? undefined);
    if (!payload) {
      send(ws, { type: 'auth_error', message: 'Invalid or missing token' });
      ws.close(1008, 'Unauthorized');
      return;
    }

    ws.userId = payload.uid;
    ws.role = payload.role;
    ws.isAlive = true;
    registerSocket(payload.uid, ws);
    send(ws, { type: 'authenticated', userId: payload.uid, role: payload.role });
    logger.info('[WS] connected', { uid: payload.uid, role: payload.role });

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
      unregisterSocket(payload.uid);
      logger.info('[WS] disconnected', { uid: payload.uid });
    });

    ws.on('error', (err) => {
      logger.warn('[WS] socket error', { uid: payload.uid, error: err.message });
    });
  });

  // Heartbeat: terminate connections that stop responding to pings.
  const interval = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as AuthedSocket;
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
