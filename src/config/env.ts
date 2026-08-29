import 'dotenv/config';
import { z } from 'zod';
import { logger } from '../utils/logger';

// Validate and normalize environment configuration at startup. A JWT secret is
// mandatory (min 32 chars); Firebase and Pi keys are optional so the server can
// boot in a degraded in-memory / no-payment mode for local development and CI.
const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(10000),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .default('dev-only-insecure-secret-change-me-0123456789abcdef'),
  PI_API_KEY: z.string().optional(),
  // Stellar secret seed (starts with "S...") for the app's own Pi wallet — the
  // same wallet Pi's U2A payments deposit into. Required only for driver payouts
  // (App-to-User transfers); everything else degrades gracefully without it.
  PI_WALLET_SEED: z.string().optional(),
  // Left unset by default — derived from PI_SANDBOX below so testnet/mainnet
  // can never be mismatched by a stale env var. Only set these explicitly to
  // override the derived value.
  PI_HORIZON_URL: z.string().optional(),
  PI_NETWORK_PASSPHRASE: z.string().optional(),
  PI_SANDBOX: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  CORS_ORIGINS: z.string().default('https://denys88888.github.io'),
  // Comma-separated Pi UIDs that are automatically promoted to role='admin' on login.
  ADMIN_UIDS: z.string().optional(),
  // Path to the SQLite database file (primary durable store). ':memory:' for tests.
  SQLITE_PATH: z.string().optional(),
  // Metered.ca account secret — mints short-lived TURN relay credentials for
  // in-app calls. Optional: without it, calls fall back to STUN-only, which
  // fails to connect across some carrier NATs (see turnCredentials.ts).
  METERED_SECRET_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  logger.error('Invalid environment configuration', {
    issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  });
  throw new Error('Environment validation failed');
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  // Stellar network to submit A2U payouts on — must match whichever network
  // PI_SANDBOX says the Pi client SDK is using, so payouts never target the
  // wrong chain. Explicit PI_HORIZON_URL/PI_NETWORK_PASSPHRASE env vars win.
  PI_HORIZON_URL:
    raw.PI_HORIZON_URL ?? (raw.PI_SANDBOX ? 'https://api.testnet.minepi.com' : 'https://api.mainnet.minepi.com'),
  PI_NETWORK_PASSPHRASE: raw.PI_NETWORK_PASSPHRASE ?? (raw.PI_SANDBOX ? 'Pi Testnet' : 'Pi Network'),
};

// Guardrails: refuse to boot in production with the insecure default secret —
// a warning is not enough, since anyone who knows the public default can forge
// admin JWTs for the deployment.
if (env.isProd && env.JWT_SECRET.startsWith('dev-only-insecure')) {
  logger.error('JWT_SECRET is using the insecure development default in production! Set a secure JWT_SECRET env var.');
  throw new Error('Refusing to start: JWT_SECRET must be set to a real secret in production');
}
if (!env.PI_API_KEY) {
  logger.warn('PI_API_KEY is not set — Pi payment endpoints will return 503.');
}
if (!env.PI_WALLET_SEED) {
  logger.warn('PI_WALLET_SEED is not set — driver payouts (A2U) will be skipped; funds stay in the app wallet.');
}
if (!env.METERED_SECRET_KEY) {
  logger.warn('METERED_SECRET_KEY is not set — in-app calls will be STUN-only and may fail to connect across some carrier networks.');
}
