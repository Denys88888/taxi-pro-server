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
  PI_SANDBOX: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  CORS_ORIGINS: z.string().default('https://denys88888.github.io'),
  RENDER_URL: z.string().optional(),
  // Comma-separated Pi UIDs that are automatically promoted to role='admin' on login.
  ADMIN_UIDS: z.string().optional(),
  // Path to the SQLite database file (primary durable store). ':memory:' for tests.
  SQLITE_PATH: z.string().optional(),
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
};

// Guardrails: warn loudly if running in production with insecure defaults.
if (env.isProd && env.JWT_SECRET.startsWith('dev-only-insecure')) {
  logger.error('JWT_SECRET is using the insecure development default in production!');
}
if (!env.PI_API_KEY) {
  logger.warn('PI_API_KEY is not set — Pi payment endpoints will return 503.');
}
