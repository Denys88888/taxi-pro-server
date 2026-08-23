import http from 'http';
import { env } from './config/env';
import { logger } from './utils/logger';
import { captureException, initSentry } from './utils/sentry';
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

// ─── No keep-alive on purpose ─────────────────────────────────────────────────
// A self-ping every 10 minutes used to live here, so the free instance would
// never hit Render's 15-minute idle spin-down. It could not do the one thing
// worth doing — a spun-down instance has no process left to ping itself awake —
// so all it ever achieved was preventing sleep. Free instance hours are billed
// only while an instance runs, and the workspace pool is 750 hours a month
// against the 744 a single always-warm service costs; on 22 Aug 2026 that
// suspended this API and pifix-api together. The original reason is gone in any
// case: it guarded an ephemeral SQLite file, and production runs Firestore,
// which survives a spin-down untouched. The cost of sleeping is a ~50s cold
// start on the first request after idle, which the client's 60s timeout covers.
// If cold starts stop being acceptable, the answer is a paid instance type, not
// a ping.

// ─── Last-resort process guards ───────────────────────────────────────────────
// A rejection nobody caught used to take the whole API down with it: Node's
// default `--unhandled-rejections=throw` turns one into an uncaught exception
// and exits with status 1. That is how a single Firestore
// `8 RESOURCE_EXHAUSTED: Quota exceeded` inside one fire-and-forget driver
// payout killed every open WebSocket and every in-flight request, then did it
// again on the next tick — a crash loop out of an error that concerned exactly
// one ride.
//
// An API that answers 500 for the affected request is strictly better than a
// dead one, and on Render's free tier every restart also costs a cold start, so
// both handlers log and keep serving. This is a net, not a strategy: whatever
// lands here is a bug at its call site and belongs fixed there.
process.on('unhandledRejection', (reason) => {
  logger.error('[Server] unhandled promise rejection — staying up', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  captureException(reason);
});
process.on('uncaughtException', (err) => {
  logger.error('[Server] uncaught exception — staying up', {
    error: err.message,
    stack: err.stack,
  });
  captureException(err);
});

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
