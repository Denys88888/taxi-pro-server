/**
 * k6 load test — Taxi Pro API
 * Run: k6 run load-test.js --env BASE_URL=https://taxi-pro-server.onrender.com
 *
 * Scenarios:
 *   passenger — login → create ride → poll status → cancel
 *   driver    — login → go online → poll open rides → submit offer → go offline
 *
 * Ramp: 0→50 VUs over 60s, sustain 5min, ramp down 30s
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Custom metrics
const rideCreated = new Counter('rides_created');
const offerSubmitted = new Counter('offers_submitted');
const authErrors = new Rate('auth_error_rate');
const rideCreateDuration = new Trend('ride_create_duration_ms', true);

export const options = {
  scenarios: {
    passenger: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '60s', target: 30 },
        { duration: '5m', target: 30 },
        { duration: '30s', target: 0 },
      ],
      exec: 'passengerFlow',
      gracefulRampDown: '15s',
    },
    driver: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '60s', target: 20 },
        { duration: '5m', target: 20 },
        { duration: '30s', target: 0 },
      ],
      exec: 'driverFlow',
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.05'],
    auth_error_rate: ['rate<0.01'],
    ride_create_duration_ms: ['p(95)<3000'],
  },
};

function devLogin(name, role = 'passenger') {
  const res = http.post(
    `${BASE}/api/auth/dev`,
    JSON.stringify({ name, role }),
    { headers: JSON_HEADERS }
  );
  const ok = check(res, { 'dev login 200': (r) => r.status === 200 });
  authErrors.add(!ok);
  if (!ok) return null;
  return JSON.parse(res.body).token;
}

function authHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

// ── Passenger scenario ────────────────────────────────────────────────────────
export function passengerFlow() {
  const uid = `p_${__VU}_${__ITER}`;
  const token = devLogin(uid, 'passenger');
  if (!token) { sleep(2); return; }

  const headers = authHeaders(token);

  // Create ride
  const start = Date.now();
  const createRes = http.post(
    `${BASE}/api/rides`,
    JSON.stringify({
      pickup: { lat: 48.4647, lng: 35.0462, address: 'Dnipro, Station' },
      destination: { lat: 48.4716, lng: 35.0385, address: 'Dnipro, Mall' },
      vehicleType: 'economy',
    }),
    { headers }
  );
  rideCreateDuration.add(Date.now() - start);
  const rideOk = check(createRes, { 'ride created 201': (r) => r.status === 201 });
  if (!rideOk) { sleep(1); return; }

  rideCreated.add(1);
  const ride = JSON.parse(createRes.body);

  // Poll status 3×
  for (let i = 0; i < 3; i++) {
    sleep(2);
    const pollRes = http.get(`${BASE}/api/rides/${ride.id}`, { headers });
    check(pollRes, { 'ride poll 200': (r) => r.status === 200 });
  }

  // Cancel
  sleep(1);
  const cancelRes = http.post(
    `${BASE}/api/rides/${ride.id}/cancel`,
    JSON.stringify({ reason: 'load test' }),
    { headers }
  );
  check(cancelRes, { 'ride cancelled 200': (r) => r.status === 200 });

  sleep(1);
}

// ── Driver scenario ───────────────────────────────────────────────────────────
export function driverFlow() {
  const uid = `d_${__VU}_${__ITER}`;
  const token = devLogin(uid, 'driver');
  if (!token) { sleep(2); return; }

  const headers = authHeaders(token);

  // Go online
  const onlineRes = http.post(
    `${BASE}/api/drivers/online`,
    JSON.stringify({ lat: 48.4647, lng: 35.0462 }),
    { headers }
  );
  check(onlineRes, { 'driver online 200': (r) => r.status === 200 });

  // Poll open rides 4×
  let openRideId = null;
  for (let i = 0; i < 4; i++) {
    sleep(3);
    const openRes = http.get(`${BASE}/api/rides/open`, { headers });
    if (check(openRes, { 'open rides 200': (r) => r.status === 200 })) {
      const data = JSON.parse(openRes.body);
      if (data.rides && data.rides.length > 0 && !openRideId) {
        openRideId = data.rides[0].id;
      }
    }
  }

  // Submit offer on first available ride
  if (openRideId) {
    const offerRes = http.post(
      `${BASE}/api/rides/${openRideId}/offers`,
      JSON.stringify({ amount: 2.5, etaMin: 5 }),
      { headers }
    );
    const offerOk = check(offerRes, {
      'offer submitted 2xx': (r) => r.status >= 200 && r.status < 300,
    });
    if (offerOk) offerSubmitted.add(1);
  }

  // Update location
  http.post(
    `${BASE}/api/drivers/location`,
    JSON.stringify({ lat: 48.4660, lng: 35.0470 }),
    { headers }
  );

  // Go offline
  sleep(1);
  http.post(`${BASE}/api/drivers/offline`, null, { headers });

  sleep(1);
}
