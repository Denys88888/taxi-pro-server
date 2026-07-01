import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { isFirebaseEnabled } from './config/firebase';
import { corsMiddleware } from './middleware/cors';
import { apiLimiter } from './middleware/rateLimit';
import { notFound, errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import rideRoutes from './routes/rides';
import driverRoutes from './routes/drivers';
import messageRoutes from './routes/messages';
import paymentRoutes from './routes/payments';
import adminRoutes from './routes/admin';
import pushRoutes from './routes/push';

// Build the Express application. Exported separately from the HTTP/WS server so
// integration tests can exercise it with supertest without opening a socket.
export function createApp(): Express {
  const app = express();

  // Security headers, incl. HSTS (HTTPS-only enforcement at the edge).
  app.use(
    helmet({
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    })
  );
  app.use(corsMiddleware);
  app.use(express.json({ limit: '1mb' }));

  // Health check (no auth) — surfaces sandbox + storage mode to the frontend.
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      sandbox: env.PI_SANDBOX,
      firebase: isFirebaseEnabled(),
      time: new Date().toISOString(),
    });
  });

  // Global rate limit on the API surface.
  app.use('/api', apiLimiter);

  // Feature routers.
  app.use('/api/auth', authRoutes);
  app.use('/api/rides', rideRoutes);
  app.use('/api/drivers', driverRoutes);
  app.use('/api/messages', messageRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/push-token', pushRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
