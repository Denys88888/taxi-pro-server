import * as Sentry from '@sentry/node';

// Optional Sentry error monitoring. Enabled only when SENTRY_DSN is set in the
// environment (Render dashboard) — without it every call here is a no-op, so
// local dev and tests are unaffected.

let enabled = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || process.env.NODE_ENV === 'test') return;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
  });
  enabled = true;
}

export function captureException(err: unknown): void {
  if (enabled) Sentry.captureException(err);
}
