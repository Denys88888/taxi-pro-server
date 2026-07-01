import http from 'http';
import { env } from './config/env';
import { logger } from './utils/logger';
import { initStore } from './models';
import { createApp } from './app';
import { initWebSocket } from './websocket/server';

// ─── Bootstrap ──────────────────────────────────────────────────────────────
initStore();

const app = createApp();
const server = http.createServer(app);
initWebSocket(server);

server.listen(env.PORT, () => {
  logger.info(`[Server] Taxi Pro API listening on :${env.PORT}`, {
    sandbox: env.PI_SANDBOX,
    env: env.NODE_ENV,
  });
});

// ─── Keep-alive (Render free tier sleeps after 15 min idle) ───────────────────
if (env.RENDER_URL) {
  setInterval(() => {
    fetch(`${env.RENDER_URL}/api/health`).catch(() => {
      /* transient network error — the next tick retries */
    });
  }, 14 * 60 * 1000);
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal: string): void {
  logger.info(`[Server] ${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  // Force-exit if connections linger.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app, server };
