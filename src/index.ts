import http from 'http';
import { env } from './config/env';
import { logger } from './utils/logger';
import { initSentry } from './utils/sentry';
import { initStore } from './models';
import { createApp } from './app';
import { initWebSocket } from './websocket/server';
import { startScheduler } from './services/scheduler';

// ─── Bootstrap ──────────────────────────────────────────────────────────────
initSentry();
initStore();

const app = createApp();
const server = http.createServer(app);
initWebSocket(server);
startScheduler();

server.listen(env.PORT, () => {
  logger.info(`[Server] Taxi Pro API listening on :${env.PORT}`, {
    sandbox: env.PI_SANDBOX,
    env: env.NODE_ENV,
  });
});

// ─── Keep-alive (Render free tier sleeps after 15 min idle) ───────────────────
// Render provides RENDER_EXTERNAL_URL automatically; RENDER_URL overrides it.
const keepAliveUrl = env.RENDER_URL ?? process.env.RENDER_EXTERNAL_URL;
if (keepAliveUrl) {
  setInterval(() => {
    fetch(`${keepAliveUrl}/api/health`).catch(() => {
      /* transient network error — the next tick retries */
    });
  }, 10 * 60 * 1000);
  logger.info('[Server] Keep-alive self-ping enabled.', { url: keepAliveUrl });
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
