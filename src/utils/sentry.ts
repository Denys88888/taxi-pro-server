import * as Sentry from '@sentry/node';
import { logger } from './logger';

// Optional Sentry error monitoring. Enabled only when SENTRY_DSN is set in the
// environment (Render dashboard) — without it every call here is a no-op, so
// local dev and tests are unaffected.

let enabled = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (process.env.NODE_ENV === 'test') return;
  if (!dsn) {
    // Said out loud in production only: a server quietly running without error
    // reporting looks exactly like one with nothing to report.
    if (process.env.NODE_ENV === 'production') {
      logger.warn('[Sentry] error reporting disabled — SENTRY_DSN is not set');
    }
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
  });
  enabled = true;
  // The DSN is set in render.yaml, but nothing ever confirmed it took. One
  // line at boot answers "is error reporting on?" from the logs alone.
  logger.info('[Sentry] error reporting enabled', {
    environment: process.env.NODE_ENV ?? 'development',
  });
}

export function captureException(err: unknown): void {
  if (enabled) Sentry.captureException(err);
}

// For /api/health: whether errors are actually being reported, answerable from
// outside the host without reading its logs.
export function isSentryEnabled(): boolean {
  return enabled;
}
