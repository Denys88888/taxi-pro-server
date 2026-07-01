import cors from 'cors';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// Strict CORS: only the whitelisted production origins are allowed. Requests with
// no Origin header (server-to-server, curl, health checks) are permitted.
// localhost / 127.0.0.1 on any port — allowed only outside production so local
// dev (Vite on :5199 etc.) can reach the API without loosening prod security.
const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export const corsMiddleware = cors({
  origin(origin, callback) {
    const allowLocal = !env.isProd && origin && LOCALHOST.test(origin);
    if (!origin || env.corsOrigins.includes(origin) || allowLocal) {
      callback(null, true);
      return;
    }
    logger.warn('[CORS] Blocked origin', { origin });
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});
