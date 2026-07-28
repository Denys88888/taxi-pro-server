import express, { type Express } from 'express';
import helmet from 'helmet';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { env } from './config/env';
import { isFirebaseEnabled } from './config/firebase';
import { storeKind } from './models';
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
import userRoutes from './routes/users';
import reportRoutes from './routes/reports';
import { store } from './models';

// Build the Express application. Exported separately from the HTTP/WS server so
// integration tests can exercise it with supertest without opening a socket.
export function createApp(): Express {
  const app = express();

  // Render (and most PaaS) put a reverse proxy in front of us. Trust exactly one
  // hop so req.ip and express-rate-limit read the real client IP from
  // X-Forwarded-For — otherwise every client shares the proxy's IP and one
  // user's traffic exhausts the rate limit for everyone. Trusting a fixed hop
  // count (not `true`) avoids X-Forwarded-For spoofing.
  app.set('trust proxy', 1);

  // Security headers, incl. HSTS (HTTPS-only enforcement at the edge) and a
  // strict Content-Security-Policy. This is a JSON API that serves no HTML or
  // scripts, so everything is locked down to 'none'.
  app.use(
    helmet({
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
    })
  );
  app.use(corsMiddleware);
  app.use(express.json({ limit: '1mb' }));

  // Swagger UI at /api/docs — standalone HTML + CDN Swagger UI (no npm package).
  // Serves the spec as JSON at /api/docs/spec.json and a plain HTML page that
  // loads Swagger UI from unpkg. No inline scripts = no CSP issues.
  try {
    const specPath = path.resolve(process.cwd(), 'openapi.yaml');
    const specJson = JSON.stringify(yaml.load(fs.readFileSync(specPath, 'utf8')));

    // Raw spec for programmatic use
    app.get('/api/docs/spec.json', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.removeHeader('Content-Security-Policy');
      res.send(specJson);
    });

    // Swagger UI HTML — CDN assets, no inline scripts
    const docsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Taxi Pro API Docs</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      SwaggerUIBundle({
        url: '/api/docs/spec.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
        deepLinking: true,
      });
    };
  </script>
</body>
</html>`;

    app.get('/api/docs', (_req, res) => {
      res.removeHeader('Content-Security-Policy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(docsHtml);
    });
    app.get('/api/docs/', (_req, res) => {
      res.removeHeader('Content-Security-Policy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(docsHtml);
    });
  } catch {
    // openapi.yaml not found — skip silently.
  }

  // Health check (no auth) — surfaces sandbox + storage mode to the frontend.
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      sandbox: env.PI_SANDBOX,
      firebase: isFirebaseEnabled(),
      store: storeKind(),
      time: new Date().toISOString(),
    });
  });

  // Global rate limit on the API surface.
  app.use('/api', apiLimiter);

  // Public settings (no auth) — the safe branding/contact/maintenance subset
  // every client needs before login; the full record (fees, fare knobs, etc.)
  // stays admin-only at /api/admin/settings. Registered AFTER apiLimiter so
  // the 60s poll from every open client can't exhaust the shared quota.
  app.get('/api/settings', async (_req, res) => {
    const settings = await store().getSettings();
    res.json({
      appName: settings.appName,
      appLogo: settings.appLogo,
      contactEmail: settings.contactEmail,
      maintenanceMode: settings.maintenanceMode,
    });
  });

  // Feature routers.
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/rides', rideRoutes);
  app.use('/api/drivers', driverRoutes);
  app.use('/api/messages', messageRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/push-token', pushRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
