# Taxi Pro — Server

Pi Network ride-hailing backend: Express REST API + WebSocket real-time layer,
Firebase Firestore persistence with an in-memory graceful fallback, JWT auth,
and Pi Platform payment forwarding.

## ⚠️ Security notice (action required)

A previous version of this repo contained a **hardcoded `PI_API_KEY`** in
`index.js`. That value is now removed from the code, but **it still exists in the
git history and must be treated as compromised**. Rotate it in the Pi Developer
Portal and set the new value only via the `PI_API_KEY` environment variable.

## Tech stack

- Node.js 20, TypeScript 5.5 (strict)
- Express 4.19, `ws` 8.17
- firebase-admin 12.2 (Firestore + FCM)
- jsonwebtoken 9 (HS256, 24h), zod 3.23, helmet 7, express-rate-limit 7, winston 3
- Jest 29 + Supertest 7

## Project layout

```
src/
  index.ts              # entry: HTTP + WebSocket server, keep-alive, shutdown
  app.ts                # Express app assembly (helmet, cors, routes)
  config/               # env (zod), firebase init, constants
  middleware/           # auth, requireRole, rateLimit, cors, validate, errorHandler
  routes/               # auth, rides, drivers, messages, payments, admin, push
  controllers/          # request handlers per domain
  services/             # piService, fcmService, rideMatching, fareCalculator
  websocket/            # server (JWT handshake), handlers, broadcast
  models/               # store interface + firestore + in-memory implementations
  utils/                # jwt, logger, helpers, asyncHandler
  types/                # shared domain types
tests/                  # jest + supertest
```

## Local development

```bash
cp .env.example .env      # fill in JWT_SECRET at minimum
npm install
npm run dev               # tsx watch on src/index.ts
```

Without Firebase configured the server runs in **in-memory mode** (non-durable),
and without `PI_API_KEY` the payment approve/complete endpoints return `503`.
This lets you develop and run the full test suite with zero external services.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch-mode dev server (tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled server (`dist/index.js`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Jest + Supertest suite |

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `JWT_SECRET` | ✅ | ≥ 32 chars. HS256 signing secret. |
| `PI_API_KEY` | for payments | Pi Developer Portal API key. Never commit. |
| `PI_SANDBOX` | | `true` (testnet, default) / `false` (mainnet). |
| `FIREBASE_PROJECT_ID` | for persistence | From the service-account JSON. |
| `FIREBASE_CLIENT_EMAIL` | for persistence | From the service-account JSON. |
| `FIREBASE_PRIVATE_KEY` | for persistence | One line, literal `\n` for newlines. |
| `CORS_ORIGINS` | | Comma-separated whitelist. |
| `PORT` | | Defaults to `10000` (Render injects it). |
| `RENDER_URL` | | Public URL; enables 14-min keep-alive self-ping. |

## API surface

Auth: `POST /api/auth/pi`. Health: `GET /api/health`.
Rides: `POST/GET /api/rides`, `GET/PATCH /api/rides/:id`, `POST /api/rides/:id/cancel`, `POST /api/rides/:id/share`.
Drivers: `POST /api/drivers/register|location|online|offline`, `GET /api/drivers/nearby`.
Messages: `GET/POST /api/messages`.
Payments: `POST /api/payments`, `GET /api/payments/:id`, `POST /api/payments/:id/approve|complete`.
Admin (role `admin`): `GET /api/admin/stats|users|rides|reports|settings|drivers/pending`,
`PATCH /api/admin/users/:id|reports/:id|settings`, `POST /api/admin/drivers/:id/verify`.
Push: `POST /api/push-token`.

All routes except `/api/health` and `/api/auth/pi` require a `Bearer` JWT.

## WebSocket protocol

Connect to `wss://<host>/?token=<jwt>`. An invalid/absent token closes the socket
with code `1008`. See `src/websocket/handlers.ts` for the full message catalog
(`ride_request`, `ride_accept`, `driver_location`, `send_message`, `ping`, …).

## Security

- Strict CORS whitelist (no wildcard), HSTS via helmet, HTTPS-only in production.
- Rate limits: 100 req/min/IP global, 10/min auth, 1/2s chat.
- Zod validation on every input; role-based access control on admin routes.
- Secrets only via env; nothing sensitive is logged.

## Deployment (Render, Docker)

`render.yaml` defines a free-tier Docker web service. Set the `sync: false` secrets
(`PI_API_KEY`, `JWT_SECRET`, the three `FIREBASE_*` vars, `RENDER_URL`) in the
Render dashboard. The `Dockerfile` builds TypeScript and runs `node dist/index.js`
on port `10000`.
