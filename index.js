// Taxi Pro — Express + WebSocket Server
// Handles: auth, Pi payments, ride matching, real-time events, push notifications
'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const {
  initFirebase, isFirebaseEnabled,
  getDoc, setDoc, updateDoc, deleteDoc,
  queryCollection, getAllOrdered, addDoc,
  getChatMessages, savePushToken, getAllPushTokens,
  sendPushNotification
} = require('./firebase');

// ─── Config ──────────────────────────────────────────────────────────────────

const PI_API_KEY = process.env.PI_API_KEY || '__PI_API_KEY_REMOVED_ROTATE_IN_PI_PORTAL__';
const JWT_SECRET = process.env.JWT_SECRET || 'taxi-pro-dev-secret-CHANGE-IN-PRODUCTION';
const PORT = process.env.PORT || 3001;

initFirebase();
console.log(`[Server] Firebase: ${isFirebaseEnabled() ? 'ENABLED' : 'DISABLED (in-memory fallback)'}`);

// ─── In-memory caches (fallback when Firebase is not configured) ──────────────

const _rides    = new Map();
const _messages = new Map();
const _drivers  = new Map();
const _payments = new Map();
const _users    = new Map();

// Live connection maps (always in-memory — transient state)
const clients       = new Map(); // clientId  → ws
const driverClients = new Map(); // driverId  → ws
const userClients   = new Map(); // userId    → ws
const pendingOffers = new Map(); // rideId    → { queue, index, timer }

// ─── Persistence helpers ──────────────────────────────────────────────────────

async function storeGetRide(id) {
  return isFirebaseEnabled() ? getDoc('rides', id) : (_rides.get(id) || null);
}
async function storeSaveRide(ride) {
  if (isFirebaseEnabled()) await setDoc('rides', ride.id, ride);
  else _rides.set(ride.id, ride);
  return ride;
}
async function storeGetAllRides(userId) {
  if (isFirebaseEnabled()) {
    const q = userId ? [{ field: 'passengerId', op: '==', value: userId }] : [];
    return queryCollection('rides', q);
  }
  const all = Array.from(_rides.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return userId ? all.filter(r => r.passengerId === userId || r.driverId === userId) : all;
}

async function storeSaveMessage(msg) {
  if (isFirebaseEnabled()) await setDoc('messages', msg.id, msg);
  else {
    if (!_messages.has(msg.chatId)) _messages.set(msg.chatId, []);
    _messages.get(msg.chatId).push(msg);
  }
}
async function storeGetMessages(chatId) {
  return isFirebaseEnabled() ? getChatMessages(chatId) : (_messages.get(chatId) || []);
}

async function storeSavePayment(payment) {
  const key = payment.id || payment.paymentId;
  if (isFirebaseEnabled()) await setDoc('payments', key, payment);
  else _payments.set(key, payment);
}
async function storeGetPayment(id) {
  return isFirebaseEnabled() ? getDoc('payments', id) : (_payments.get(id) || null);
}

async function storeSaveDriver(driver) {
  if (isFirebaseEnabled()) await setDoc('drivers', driver.id, driver);
  else _drivers.set(driver.id, driver);
  return driver;
}
async function storeGetDriver(id) {
  return isFirebaseEnabled() ? getDoc('drivers', id) : (_drivers.get(id) || null);
}
async function storeGetOnlineDrivers() {
  if (isFirebaseEnabled()) return queryCollection('drivers', [{ field: 'isOnline', op: '==', value: true }]);
  return Array.from(_drivers.values()).filter(d => d.isOnline);
}

async function storeSaveUser(user) {
  if (isFirebaseEnabled()) await setDoc('users', user.piUserId, user);
  else _users.set(user.piUserId, user);
  return user;
}
async function storeGetUser(id) {
  return isFirebaseEnabled() ? getDoc('users', id) : (_users.get(id) || null);
}

// ─── Haversine distance (km) ──────────────────────────────────────────────────

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Driver matching: nearest-first, 30 s per offer ──────────────────────────

async function startDriverMatching(ride) {
  const pickup = ride.pickupLocation || ride.pickup;
  if (!pickup) { notifyPassenger(ride, 'ride:no_drivers'); return; }

  const online = await storeGetOnlineDrivers();
  const nearby = online
    .filter(d => d.location && haversine(pickup.lat, pickup.lng, d.location.lat, d.location.lng) <= 5)
    .map(d => ({ ...d, dist: haversine(pickup.lat, pickup.lng, d.location.lat, d.location.lng) }))
    .sort((a, b) => a.dist - b.dist);

  if (!nearby.length) { notifyPassenger(ride, 'ride:no_drivers'); return; }

  pendingOffers.set(ride.id, { queue: nearby.map(d => d.id), index: 0, rideId: ride.id });
  offerNext(ride.id, ride);
}

function offerNext(rideId, ride) {
  const offer = pendingOffers.get(rideId);
  if (!offer) return;
  if (offer.index >= offer.queue.length) {
    pendingOffers.delete(rideId);
    notifyPassenger(ride, 'ride:no_drivers');
    return;
  }
  const driverId = offer.queue[offer.index];
  const ws = driverClients.get(driverId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    offer.index++;
    offerNext(rideId, ride);
    return;
  }
  ws.send(JSON.stringify({ type: 'ride:offer', rideId, ride, expiresIn: 30 }));
  offer.timer = setTimeout(() => { offer.index++; offerNext(rideId, ride); }, 30000);
}

function cancelOffer(rideId) {
  const offer = pendingOffers.get(rideId);
  if (offer?.timer) clearTimeout(offer.timer);
  pendingOffers.delete(rideId);
}

function notifyPassenger(ride, type, extra = {}) {
  const ws = userClients.get(ride.passengerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, rideId: ride.id, ...extra }));
  }
}

// ─── Push notification helper ─────────────────────────────────────────────────

async function pushToUser(userId, title, body, data = {}) {
  if (!isFirebaseEnabled()) return;
  try {
    const tokens = await getAllPushTokens();
    const rec = tokens.find(t => t.userId === userId);
    if (rec?.token) await sendPushNotification(rec.token, title, body, data);
  } catch (err) {
    console.error('[Push]', err.message);
  }
}

// ─── Pi API helpers ───────────────────────────────────────────────────────────

function piPost(path, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.minepi.com', path, method: 'POST',
      headers: {
        'Authorization': `Key ${PI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function piGet(path, bearerToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.minepi.com', path, method: 'GET',
      headers: { 'Authorization': `Bearer ${bearerToken}` }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// Rate limit for ride creation: 10 per minute per IP
const rideLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again in a minute.' }
});

// JWT middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Keep-alive endpoint (spec requirement)
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: Date.now() }));
app.get('/api/health', (_, res) => res.json({ status: 'ok', firebase: isFirebaseEnabled(), timestamp: new Date().toISOString() }));

// Auth: verify Pi accessToken → issue JWT
app.post('/auth/verify', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'Missing accessToken' });

    const { status, data: piUser } = await piGet('/v2/me', accessToken);
    if (status !== 200) return res.status(401).json({ error: 'Invalid Pi accessToken', piStatus: status });

    const userId = piUser.uid;
    const existingUser = await storeGetUser(userId);
    const user = {
      piUserId: userId,
      piUsername: piUser.username,
      name: existingUser?.name || piUser.username,
      phone: existingUser?.phone || null,
      rating: existingUser?.rating || 5.0,
      totalRides: existingUser?.totalRides || 0,
      role: existingUser?.role || 'passenger',
      createdAt: existingUser?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await storeSaveUser(user);

    const token = jwt.sign({ userId, piUsername: piUser.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user });
  } catch (err) {
    console.error('[Auth]', err.message);
    res.status(500).json({ error: 'Auth failed' });
  }
});

// Update user profile
app.patch('/api/users/:id', requireAuth, async (req, res) => {
  try {
    const existing = await storeGetUser(req.params.id);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    const updated = { ...existing, ...req.body, updatedAt: new Date().toISOString() };
    await storeSaveUser(updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push token
app.post('/api/push-token', async (req, res) => {
  const { userId, token } = req.body;
  if (!userId || !token) return res.status(400).json({ error: 'Missing fields' });
  await savePushToken(userId, token);
  res.json({ success: true });
});

// Pi payments: approve
app.post('/api/payments/:id/approve', async (req, res) => {
  try {
    const { status, data } = await piPost(`/v2/payments/${req.params.id}/approve`);
    await storeSavePayment({ paymentId: req.params.id, status: data.status || 'approved', piResponse: data, updatedAt: new Date().toISOString() });
    res.json({ success: status === 200, paymentId: req.params.id, status: data.status || 'approved', data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pi payments: complete
app.post('/api/payments/:id/complete', async (req, res) => {
  try {
    const { txid } = req.body;
    if (!txid) return res.status(400).json({ error: 'Missing txid' });
    const { status, data } = await piPost(`/v2/payments/${req.params.id}/complete`, { txid });
    await storeSavePayment({ paymentId: req.params.id, status: data.status || 'completed', txid, piResponse: data, updatedAt: new Date().toISOString() });
    res.json({ success: status === 200, paymentId: req.params.id, txid, status: data.status || 'completed', data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pi payments: get
app.get('/api/payments/:id', async (req, res) => {
  const p = await storeGetPayment(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

// Rides: create (rate-limited)
app.post('/api/rides', rideLimiter, async (req, res) => {
  try {
    const ride = {
      id: 'ride_' + Date.now(),
      ...req.body,
      status: 'searching',
      createdAt: new Date().toISOString()
    };
    await storeSaveRide(ride);
    startDriverMatching(ride).catch(console.error);
    res.status(201).json(ride);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rides: list (optionally by userId)
app.get('/api/rides', async (req, res) => {
  const rides = await storeGetAllRides(req.query.userId);
  res.json(rides);
});

// Rides: get one
app.get('/api/rides/:id', async (req, res) => {
  const ride = await storeGetRide(req.params.id);
  if (!ride) return res.status(404).json({ error: 'Not found' });
  res.json(ride);
});

// Rides: update status
app.patch('/api/rides/:id', async (req, res) => {
  const ride = await storeGetRide(req.params.id);
  if (!ride) return res.status(404).json({ error: 'Not found' });
  const updated = { ...ride, ...req.body, updatedAt: new Date().toISOString() };
  await storeSaveRide(updated);
  broadcast({ type: 'ride_updated', rideId: req.params.id, status: updated.status, updates: req.body });
  res.json(updated);
});

// Messages: list for a chat
app.get('/api/messages', async (req, res) => {
  const msgs = await storeGetMessages(req.query.chatId || 'default');
  res.json(msgs);
});

// Ratings: submit
app.post('/api/ratings', async (req, res) => {
  if (!isFirebaseEnabled()) return res.status(503).json({ error: 'Requires Firebase' });
  const rating = {
    id: 'rating_' + Date.now(),
    ...req.body,
    createdAt: new Date().toISOString()
  };
  await setDoc('ratings', rating.id, rating);

  // Update target user average rating
  const target = await storeGetUser(req.body.toUser);
  if (target) {
    const count = (target.totalRatings || 0) + 1;
    const avg = ((target.rating || 5.0) * (count - 1) + req.body.score) / count;
    await storeSaveUser({ ...target, rating: Math.round(avg * 10) / 10, totalRatings: count });
  }

  res.status(201).json(rating);
});

// Promo codes: validate
app.post('/api/promos/validate', async (req, res) => {
  if (!isFirebaseEnabled()) return res.status(503).json({ error: 'Requires Firebase' });
  const { code, userId } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const promo = await getDoc('promos', code.toUpperCase());
  if (!promo) return res.status(404).json({ error: 'Invalid promo code' });
  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return res.status(400).json({ error: 'Promo expired' });
  if (promo.usedBy?.includes(userId)) return res.status(400).json({ error: 'Already used' });
  if (promo.maxUses && (promo.usedBy?.length ?? 0) >= promo.maxUses) return res.status(400).json({ error: 'Limit reached' });

  res.json({ valid: true, discount: promo.discount, type: promo.type });
});

// Share ride: generate read-only token
app.post('/api/rides/:id/share', async (req, res) => {
  const ride = await storeGetRide(req.params.id);
  if (!ride) return res.status(404).json({ error: 'Not found' });
  const shareToken = jwt.sign({ rideId: req.params.id, readonly: true }, JWT_SECRET, { expiresIn: '4h' });
  if (isFirebaseEnabled()) await setDoc('shareTokens', shareToken.slice(-16), { rideId: req.params.id, token: shareToken, createdAt: new Date().toISOString() });
  res.json({ token: shareToken });
});

// Share ride: get by token
app.get('/api/share/:token', async (req, res) => {
  try {
    const { rideId } = jwt.verify(req.params.token, JWT_SECRET);
    const ride = await storeGetRide(rideId);
    if (!ride) return res.status(404).json({ error: 'Not found' });
    res.json({ rideId, status: ride.status, driverId: ride.driverId });
  } catch {
    res.status(401).json({ error: 'Invalid share token' });
  }
});

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(app);

// ─── WebSocket ────────────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ server });

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function sendToUser(userId, data) {
  const ws = userClients.get(userId);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function sendToDriver(driverId, data) {
  const ws = driverClients.get(driverId);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws) => {
  const clientId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  clients.set(clientId, ws);
  ws._clientId = clientId;

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    try {
      await handleWsMessage(ws, msg);
    } catch (err) {
      console.error('[WS] Error:', msg.type, err.message);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    if (ws._userId) userClients.delete(ws._userId);
    if (ws._driverId) {
      driverClients.delete(ws._driverId);
      storeSaveDriver({ ...(ws._driverData || { id: ws._driverId }), isOnline: false, offlineAt: new Date().toISOString() }).catch(() => {});
    }
    console.log(`[WS] Disconnected: ${clientId} | Total: ${clients.size}`);
  });

  ws.send(JSON.stringify({ type: 'connected', clientId, time: Date.now() }));
  console.log(`[WS] Connected: ${clientId} | Total: ${clients.size}`);
});

async function handleWsMessage(ws, msg) {
  switch (msg.type) {

    // ── Auth ──────────────────────────────────────────────────────

    case 'auth': {
      // Client sends JWT to identify itself on the WebSocket connection
      try {
        const decoded = jwt.verify(msg.token, JWT_SECRET);
        ws._userId = decoded.userId;
        userClients.set(decoded.userId, ws);
        ws.send(JSON.stringify({ type: 'auth:ok', userId: decoded.userId }));
      } catch {
        ws.send(JSON.stringify({ type: 'auth:fail', message: 'Invalid token' }));
      }
      break;
    }

    // ── Driver: online ────────────────────────────────────────────

    case 'driver:online': {
      const driver = {
        id: msg.driverId,
        name: msg.name,
        carModel: msg.carModel,
        carColor: msg.carColor,
        plateNumber: msg.plateNumber,
        rating: msg.rating ?? 5.0,
        isOnline: true,
        location: msg.location,
        onlineAt: new Date().toISOString()
      };
      await storeSaveDriver(driver);
      ws._driverId = msg.driverId;
      ws._driverData = driver;
      driverClients.set(msg.driverId, ws);
      broadcast({ type: 'drivers:update', driverId: msg.driverId, location: msg.location, isOnline: true });
      ws.send(JSON.stringify({ type: 'driver:online:ack', driverId: msg.driverId }));
      break;
    }

    // ── Driver: location update ───────────────────────────────────

    case 'driver:location': {
      const existing = ws._driverData || await storeGetDriver(msg.driverId) || { id: msg.driverId };
      const updated = { ...existing, location: msg.location, updatedAt: new Date().toISOString() };
      ws._driverData = updated;
      await storeSaveDriver(updated);
      // Broadcast to everyone (passenger will filter for their ride's driver)
      broadcast({ type: 'driver:location', driverId: msg.driverId, location: msg.location, rideId: msg.rideId });
      break;
    }

    // ── Driver: offline ───────────────────────────────────────────

    case 'driver:offline': {
      const d = ws._driverData || await storeGetDriver(msg.driverId) || { id: msg.driverId };
      await storeSaveDriver({ ...d, isOnline: false, offlineAt: new Date().toISOString() });
      driverClients.delete(msg.driverId);
      ws._driverId = null;
      broadcast({ type: 'drivers:update', driverId: msg.driverId, isOnline: false });
      ws.send(JSON.stringify({ type: 'driver:offline:ack' }));
      break;
    }

    // ── Ride: request (from passenger) ────────────────────────────

    case 'ride:request': {
      const ride = {
        id: 'ride_' + Date.now(),
        passengerId: msg.passengerId,
        pickupLocation: msg.pickupLocation,
        dropoffLocation: msg.dropoffLocation,
        fare: msg.fare,
        distance: msg.distance,
        duration: msg.duration,
        surgeMultiplier: msg.surgeMultiplier || 1.0,
        paymentId: msg.paymentId,
        status: 'searching',
        createdAt: new Date().toISOString()
      };
      if (msg.passengerId) {
        ws._userId = msg.passengerId;
        userClients.set(msg.passengerId, ws);
      }
      await storeSaveRide(ride);
      ws.send(JSON.stringify({ type: 'ride:searching', rideId: ride.id }));
      await startDriverMatching(ride);
      break;
    }

    // ── Ride: accept (from driver) ────────────────────────────────

    case 'ride:accept': {
      const offer = pendingOffers.get(msg.rideId);
      if (offer) {
        if (offer.timer) clearTimeout(offer.timer);
        pendingOffers.delete(msg.rideId);
      }
      const ride = await storeGetRide(msg.rideId);
      if (!ride) { ws.send(JSON.stringify({ type: 'error', message: 'Ride not found' })); break; }
      if (ride.status !== 'searching') { ws.send(JSON.stringify({ type: 'error', message: 'Ride no longer available' })); break; }

      const driverInfo = await storeGetDriver(msg.driverId) || { id: msg.driverId };
      const updated = { ...ride, status: 'accepted', driverId: msg.driverId, acceptedAt: new Date().toISOString() };
      await storeSaveRide(updated);

      sendToUser(ride.passengerId, { type: 'ride:accepted', rideId: msg.rideId, driverInfo, status: 'accepted' });
      ws.send(JSON.stringify({ type: 'ride:accept:ack', rideId: msg.rideId, passengerId: ride.passengerId, pickupLocation: ride.pickupLocation }));
      await pushToUser(ride.passengerId, 'Driver Found!', `${driverInfo.name || 'Your driver'} is on the way.`, { type: 'driver-found', rideId: msg.rideId });
      break;
    }

    // ── Ride: arrived at pickup ───────────────────────────────────

    case 'ride:arrived': {
      const ride = await storeGetRide(msg.rideId);
      if (!ride) break;
      await storeSaveRide({ ...ride, status: 'arrived', arrivedAt: new Date().toISOString() });
      sendToUser(ride.passengerId, { type: 'ride:arrived', rideId: msg.rideId });
      await pushToUser(ride.passengerId, 'Driver Arrived!', 'Your driver is waiting at the pickup.', { type: 'driver-arriving', rideId: msg.rideId });
      break;
    }

    // ── Ride: start ───────────────────────────────────────────────

    case 'ride:start': {
      const ride = await storeGetRide(msg.rideId);
      if (!ride) break;
      await storeSaveRide({ ...ride, status: 'in_progress', startedAt: new Date().toISOString() });
      sendToUser(ride.passengerId, { type: 'ride:started', rideId: msg.rideId });
      break;
    }

    // ── Ride: complete ────────────────────────────────────────────

    case 'ride:complete': {
      const ride = await storeGetRide(msg.rideId);
      if (!ride) break;
      await storeSaveRide({ ...ride, status: 'completed', completedAt: new Date().toISOString(), paymentId: msg.paymentId || ride.paymentId });
      sendToUser(ride.passengerId, { type: 'ride:completed', rideId: msg.rideId, fare: ride.fare });
      ws.send(JSON.stringify({ type: 'ride:complete:ack', rideId: msg.rideId }));
      await pushToUser(ride.passengerId, 'Ride Complete', `Fare: ${ride.fare} Pi. Please rate your driver.`, { type: 'payment', rideId: msg.rideId });
      break;
    }

    // ── Ride: cancel ──────────────────────────────────────────────

    case 'ride:cancel': {
      cancelOffer(msg.rideId);
      const ride = await storeGetRide(msg.rideId);
      if (!ride) break;
      await storeSaveRide({ ...ride, status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: msg.reason || '', cancelledBy: msg.cancelledBy });
      // Notify both parties
      sendToUser(ride.passengerId, { type: 'ride:cancelled', rideId: msg.rideId, reason: msg.reason });
      if (ride.driverId) sendToDriver(ride.driverId, { type: 'ride:cancelled', rideId: msg.rideId, reason: msg.reason });
      break;
    }

    // ── Chat ──────────────────────────────────────────────────────

    case 'chat:message': {
      const chatMsg = {
        id: 'msg_' + Date.now(),
        rideId: msg.rideId,
        chatId: msg.rideId || msg.chatId || 'default',
        sender: msg.sender,
        senderName: msg.senderName,
        text: msg.text,
        timestamp: new Date().toISOString()
      };
      await storeSaveMessage(chatMsg);
      broadcast({ type: 'chat:message', message: chatMsg });
      break;
    }

    case 'join_chat': {
      ws._chatId = msg.chatId;
      const history = await storeGetMessages(msg.chatId);
      ws.send(JSON.stringify({ type: 'chat:history', chatId: msg.chatId, messages: history }));
      break;
    }

    // ── Ping / pong ───────────────────────────────────────────────

    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
      break;
    }

    // ── Legacy events (keep for backwards compat) ─────────────────

    case 'driver_register': {
      const driver = {
        id: msg.driverId || ('driver_' + Date.now()),
        name: msg.name,
        isOnline: true,
        location: msg.lat && msg.lng ? { lat: msg.lat, lng: msg.lng } : null,
        vehicle: msg.vehicle,
        onlineAt: new Date().toISOString()
      };
      await storeSaveDriver(driver);
      ws._driverId = driver.id;
      driverClients.set(driver.id, ws);
      ws.send(JSON.stringify({ type: 'driver_registered', driverId: driver.id }));
      break;
    }

    case 'ride_request': {
      const ride = {
        id: 'ride_' + Date.now(),
        passengerId: msg.passengerId,
        pickup: msg.pickup,
        destination: msg.destination,
        fare: msg.fare || 0,
        status: 'searching',
        createdAt: new Date().toISOString()
      };
      await storeSaveRide(ride);
      broadcast({ type: 'ride_available', ride });
      ws.send(JSON.stringify({ type: 'ride_requested', rideId: ride.id, status: 'searching' }));
      break;
    }

    case 'ride_accept': {
      const ride = await storeGetRide(msg.rideId);
      if (ride) {
        await storeSaveRide({ ...ride, status: 'driver_assigned', driverId: msg.driverId });
        broadcast({ type: 'ride_assigned', rideId: msg.rideId, driverId: msg.driverId, driverInfo: msg.driverInfo || {} });
      }
      break;
    }

    case 'ride_status': {
      broadcast({ type: 'ride_status_update', rideId: msg.rideId, status: msg.status, data: msg.data });
      break;
    }

    case 'driver_location': {
      broadcast({ type: 'driver_location_update', rideId: msg.rideId, lat: msg.lat, lng: msg.lng });
      break;
    }

    case 'send_message': {
      const m = { id: 'msg_' + Date.now(), chatId: msg.chatId, sender: msg.sender, text: msg.text, timestamp: new Date().toISOString() };
      await storeSaveMessage(m);
      broadcast({ type: 'new_message', message: m });
      break;
    }

    default:
      console.log('[WS] Unknown type:', msg.type);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[Server] Taxi Pro running on port ${PORT}`);
  console.log(`[Server] Health: http://localhost:${PORT}/health`);
  console.log(`[Server] WS: ws://localhost:${PORT}`);
});
