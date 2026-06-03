// Taxi Pro — WebSocket Server for real-time features
// Chat, notifications, ride status updates
// Now with Firestore persistence + graceful in-memory fallback

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const {
  initFirebase, firebaseEnabled, isFirebaseEnabled,
  getDoc, setDoc, updateDoc, deleteDoc,
  queryCollection, getAllOrdered, addDoc,
  getChatMessages, savePushToken, getAllPushTokens,
  sendPushNotification, admin
} = require('./firebase');

// Pi Platform API Key (server-side only — never expose to client)
const PI_API_KEY = '__PI_API_KEY_REMOVED_ROTATE_IN_PI_PORTAL__';

// Initialize Firebase (reads env vars / serviceAccount.json)
initFirebase();

// In-memory caches used when Firebase is NOT configured
const _rides = new Map();
const _messages = new Map();
const _drivers = new Map();
const _payments = new Map();
const clients = new Map(); // WebSocket clients always in-memory

// Log persistence mode on startup
console.log(`[Server] Firebase persistence: ${isFirebaseEnabled() ? 'ENABLED' : 'DISABLED (in-memory mode)'}`);

// ═══════════════════════════════════════════════════════════════
// Unified CRUD — Firestore when available, in-memory Map fallback
// ═══════════════════════════════════════════════════════════════

async function storeGetRide(rideId) {
  if (isFirebaseEnabled()) {
    return getDoc('rides', rideId);
  }
  return _rides.get(rideId) || null;
}

async function storeSaveRide(ride) {
  if (isFirebaseEnabled()) {
    await setDoc('rides', ride.id, ride);
  } else {
    _rides.set(ride.id, ride);
  }
  return ride;
}

async function storeGetAllRides() {
  if (isFirebaseEnabled()) {
    return getAllOrdered('rides', 'createdAt', 'desc');
  }
  return Array.from(_rides.values()).sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt)
  );
}

async function storeSaveMessage(msg) {
  if (isFirebaseEnabled()) {
    await setDoc('messages', msg.id, msg);
  } else {
    if (!_messages.has(msg.chatId)) _messages.set(msg.chatId, []);
    _messages.get(msg.chatId).push(msg);
  }
  return msg;
}

async function storeGetMessages(chatId) {
  if (isFirebaseEnabled()) {
    return getChatMessages(chatId);
  }
  return _messages.get(chatId) || [];
}

async function storeSavePayment(payment) {
  if (isFirebaseEnabled()) {
    await setDoc('payments', payment.id, payment);
  } else {
    _payments.set(payment.id, payment);
  }
  return payment;
}

async function storeGetPayment(paymentId) {
  if (isFirebaseEnabled()) {
    return getDoc('payments', paymentId);
  }
  return _payments.get(paymentId) || null;
}

async function storeSaveDriver(driver) {
  if (isFirebaseEnabled()) {
    await setDoc('drivers', driver.id, driver);
  } else {
    _drivers.set(driver.id, driver);
  }
  return driver;
}

async function storeGetDriver(driverId) {
  if (isFirebaseEnabled()) {
    return getDoc('drivers', driverId);
  }
  return _drivers.get(driverId) || null;
}

async function storeGetAvailableRides() {
  if (isFirebaseEnabled()) {
    return queryCollection('rides', [
      { field: 'status', op: '==', value: 'searching' }
    ]);
  }
  return Array.from(_rides.values()).filter(r => r.status === 'searching');
}

async function storeUpdatePayment(paymentId, updates) {
  if (isFirebaseEnabled()) {
    await setDoc('payments', paymentId, updates);
  } else {
    const existing = _payments.get(paymentId) || {};
    _payments.set(paymentId, { ...existing, ...updates });
  }
}

// Push-notification helper: notify a user by looking up their stored token
async function notifyUser(userId, title, body, data = {}) {
  if (!isFirebaseEnabled()) return;
  try {
    const tokensSnapshot = await getAllPushTokens();
    const userTokenRecord = tokensSnapshot.find(t => t.userId === userId);
    if (userTokenRecord && userTokenRecord.token) {
      await sendPushNotification(userTokenRecord.token, title, body, data);
    }
  } catch (err) {
    console.error('[Push] notifyUser error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// HTTP Server
// ═══════════════════════════════════════════════════════════════

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── Health ──
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      firebase: isFirebaseEnabled(),
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // ── POST /api/push-token ──
  if (url.pathname === '/api/push-token' && req.method === 'POST') {
    collectBody(req, async (body) => {
      try {
        const { userId, token } = JSON.parse(body);
        if (!userId || !token) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing userId or token' }));
          return;
        }
        await savePushToken(userId, token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // ── Rides CRUD ──

  // POST /api/rides — create
  if (url.pathname === '/api/rides' && req.method === 'POST') {
    collectBody(req, async (body) => {
      try {
        const ride = JSON.parse(body);
        ride.id = 'ride_' + Date.now();
        ride.status = 'searching';
        ride.createdAt = new Date().toISOString();
        await storeSaveRide(ride);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ride));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // GET /api/rides — list all
  if (url.pathname === '/api/rides' && req.method === 'GET') {
    (async () => {
      try {
        const rideList = await storeGetAllRides();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rideList));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // GET /api/rides/:id — get one
  if (url.pathname.startsWith('/api/rides/') && req.method === 'GET') {
    (async () => {
      try {
        const rideId = url.pathname.split('/')[3];
        const ride = await storeGetRide(rideId);
        if (ride) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(ride));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Ride not found' }));
        }
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // PATCH /api/rides/:id — update
  if (url.pathname.startsWith('/api/rides/') && req.method === 'PATCH') {
    collectBody(req, async (body) => {
      try {
        const rideId = url.pathname.split('/')[3];
        const updates = JSON.parse(body);
        const ride = await storeGetRide(rideId);
        if (ride) {
          const updatedRide = { ...ride, ...updates };
          await storeSaveRide(updatedRide);
          // Broadcast status update to all connected clients
          broadcast({
            type: 'ride_updated',
            rideId,
            status: updatedRide.status,
            updates
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(updatedRide));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Ride not found' }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // ── Messages CRUD ──

  // POST /api/messages — create
  if (url.pathname === '/api/messages' && req.method === 'POST') {
    collectBody(req, async (body) => {
      try {
        const msg = JSON.parse(body);
        msg.id = 'msg_' + Date.now();
        msg.timestamp = new Date().toISOString();

        const chatId = msg.chatId || 'default';
        msg.chatId = chatId;

        await storeSaveMessage(msg);

        // Broadcast to chat participants
        broadcast({
          type: 'new_message',
          chatId,
          message: msg
        });

        // Push notification to chat participants
        if (msg.sender && msg.text) {
          try {
            const allMessages = await storeGetMessages(chatId);
            const participants = [...new Set(allMessages.map(m => m.sender))];
            for (const participant of participants) {
              if (participant !== msg.sender) {
                await notifyUser(participant, 'New Message', `${msg.sender}: ${msg.text}`, {
                  type: 'new_message',
                  chatId,
                  messageId: msg.id
                });
              }
            }
          } catch (pushErr) {
            console.error('[Push] Message notification error:', pushErr.message);
          }
        }

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(msg));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // GET /api/messages — list for chat
  if (url.pathname === '/api/messages' && req.method === 'GET') {
    (async () => {
      try {
        const chatId = url.searchParams.get('chatId') || 'default';
        const chatMessages = await storeGetMessages(chatId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(chatMessages));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // ── Pi Payment API ──

  // POST /api/payments — create a new payment record
  if (url.pathname === '/api/payments' && req.method === 'POST') {
    collectBody(req, async (body) => {
      try {
        const data = JSON.parse(body);
        const payment = {
          id: 'payment_' + Date.now(),
          amount: data.amount,
          memo: data.memo,
          metadata: data.metadata || {},
          rideId: data.rideId || null,
          status: 'created',
          createdAt: new Date().toISOString()
        };
        await storeSavePayment(payment);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payment));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // GET /api/payments/:id — return payment details
  if (url.pathname.startsWith('/api/payments/') && req.method === 'GET' && !url.pathname.endsWith('/approve') && !url.pathname.endsWith('/complete')) {
    (async () => {
      try {
        const paymentId = url.pathname.split('/')[3];
        const payment = await storeGetPayment(paymentId);
        if (payment) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payment));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Payment not found' }));
        }
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // POST /api/payments/:id/approve — forward to Pi Platform API
  if (url.pathname.startsWith('/api/payments/') && url.pathname.endsWith('/approve') && req.method === 'POST') {
    const paymentId = url.pathname.split('/')[3];
    const piUrl = `https://api.minepi.com/v2/payments/${paymentId}/approve`;

    const postData = JSON.stringify({});
    const options = {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const piReq = https.request(piUrl, options, (piRes) => {
      let piData = '';
      piRes.on('data', chunk => piData += chunk);
      piRes.on('end', async () => {
        try {
          const piResponse = JSON.parse(piData);
          const status = piResponse.status || 'approved';
          const existing = await storeGetPayment(paymentId) || {};
          await storeSavePayment({ ...existing, paymentId, status, piResponse });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, paymentId, status }));
        } catch (e) {
          const existing = await storeGetPayment(paymentId) || {};
          await storeSavePayment({ ...existing, paymentId, status: 'approved' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, paymentId, status: 'approved' }));
        }
      });
    });

    piReq.on('error', (err) => {
      console.error('[Pi API] Approve error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });

    piReq.write(postData);
    piReq.end();
    return;
  }

  // POST /api/payments/:id/complete — forward to Pi Platform API with txid
  if (url.pathname.startsWith('/api/payments/') && url.pathname.endsWith('/complete') && req.method === 'POST') {
    collectBody(req, async (body) => {
      try {
        const { txid } = JSON.parse(body);
        const paymentId = url.pathname.split('/')[3];
        const piUrl = `https://api.minepi.com/v2/payments/${paymentId}/complete`;
        const postData = JSON.stringify({ txid });

        const options = {
          method: 'POST',
          headers: {
            'Authorization': `Key ${PI_API_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        };

        const piReq = https.request(piUrl, options, (piRes) => {
          let piData = '';
          piRes.on('data', chunk => piData += chunk);
          piRes.on('end', async () => {
            try {
              const piResponse = JSON.parse(piData);
              const status = piResponse.status || 'completed';
              const existing = await storeGetPayment(paymentId) || {};
              await storeSavePayment({ ...existing, paymentId, status, txid, piResponse });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, paymentId, txid, status }));
            } catch (e) {
              const existing = await storeGetPayment(paymentId) || {};
              await storeSavePayment({ ...existing, paymentId, status: 'completed', txid });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, paymentId, txid, status: 'completed' }));
            }
          });
        });

        piReq.on('error', (err) => {
          console.error('[Pi API] Complete error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });

        piReq.write(postData);
        piReq.end();
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON, expected { txid }' }));
      }
    });
    return;
  }

  // ── 404 ──
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ═══════════════════════════════════════════════════════════════
// WebSocket Server
// ═══════════════════════════════════════════════════════════════

const wss = new WebSocket.Server({ server });

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws, req) => {
  const clientId = 'client_' + Date.now();
  clients.set(clientId, ws);

  console.log('[WS] Client connected:', clientId, 'Total:', clients.size);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'join_chat': {
          ws.chatId = msg.chatId;
          const chatMessages = await storeGetMessages(msg.chatId);
          ws.send(JSON.stringify({
            type: 'joined',
            chatId: msg.chatId,
            messages: chatMessages
          }));
          break;
        }

        case 'send_message': {
          const chatMsg = {
            id: 'msg_' + Date.now(),
            chatId: msg.chatId,
            sender: msg.sender,
            text: msg.text,
            timestamp: new Date().toISOString()
          };
          await storeSaveMessage(chatMsg);
          broadcast({ type: 'new_message', message: chatMsg });

          // Push notification to other chat participants
          try {
            const allMessages = await storeGetMessages(msg.chatId);
            const participants = [...new Set(allMessages.map(m => m.sender))];
            for (const participant of participants) {
              if (participant !== msg.sender) {
                await notifyUser(participant, 'New Message', `${msg.sender}: ${msg.text}`, {
                  type: 'new_message',
                  chatId: msg.chatId,
                  messageId: chatMsg.id
                });
              }
            }
          } catch (pushErr) {
            console.error('[Push] WS message notification error:', pushErr.message);
          }
          break;
        }

        case 'ride_status': {
          broadcast({
            type: 'ride_status_update',
            rideId: msg.rideId,
            status: msg.status,
            data: msg.data
          });
          break;
        }

        case 'driver_location': {
          broadcast({
            type: 'driver_location_update',
            rideId: msg.rideId,
            lat: msg.lat,
            lng: msg.lng
          });
          break;
        }

        case 'ride_request': {
          // Passenger creates a ride request
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
          broadcast({
            type: 'ride_available',
            ride
          });
          ws.send(JSON.stringify({
            type: 'ride_requested',
            rideId: ride.id,
            status: 'searching'
          }));
          break;
        }

        case 'ride_accept': {
          // Driver accepts a ride
          const ride = await storeGetRide(msg.rideId);
          if (ride) {
            const updatedRide = {
              ...ride,
              status: 'driver_assigned',
              driverId: msg.driverId
            };
            await storeSaveRide(updatedRide);
            broadcast({
              type: 'ride_assigned',
              rideId: msg.rideId,
              driverId: msg.driverId,
              driverInfo: msg.driverInfo || {},
              status: 'driver_assigned'
            });

            // Push notification to passenger
            if (ride.passengerId) {
              try {
                await notifyUser(
                  ride.passengerId,
                  'Driver Assigned',
                  'A driver has accepted your ride request!',
                  { type: 'ride_assigned', rideId: msg.rideId }
                );
              } catch (pushErr) {
                console.error('[Push] ride_accept notification error:', pushErr.message);
              }
            }

            // Push notification to driver who accepted
            try {
              await notifyUser(
                msg.driverId,
                'Ride Accepted',
                'You have accepted a new ride request.',
                { type: 'ride_accepted', rideId: msg.rideId }
              );
            } catch (pushErr) {
              console.error('[Push] driver accept notification error:', pushErr.message);
            }
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Ride not found'
            }));
          }
          break;
        }

        case 'ride_decline': {
          // Driver declines a ride
          broadcast({
            type: 'ride_declined',
            rideId: msg.rideId,
            driverId: msg.driverId
          });
          break;
        }

        case 'driver_register': {
          // Driver comes online
          const driver = {
            id: msg.driverId || 'driver_' + Date.now(),
            name: msg.name,
            lat: msg.lat,
            lng: msg.lng,
            vehicle: msg.vehicle,
            onlineAt: new Date().toISOString()
          };
          await storeSaveDriver(driver);
          ws.driverId = driver.id;

          // Send back list of available (searching) rides
          const availableRides = await storeGetAvailableRides();
          ws.send(JSON.stringify({
            type: 'driver_registered',
            driverId: driver.id,
            availableRides
          }));
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
          break;
        }

        default: {
          console.log('[WS] Unknown message type:', msg.type);
        }
      }
    } catch (e) {
      console.error('[WS] Error processing message:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    console.log('[WS] Client disconnected:', clientId, 'Total:', clients.size);
  });

  // Send welcome
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    message: 'Connected to Taxi Pro real-time server'
  }));
});

// ═══════════════════════════════════════════════════════════════
// Utility: collect request body for async handlers
// ═══════════════════════════════════════════════════════════════

function collectBody(req, callback) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => callback(body));
}

// ═══════════════════════════════════════════════════════════════
// Start server
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Taxi Pro WebSocket server running on port ${PORT}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/api/health`);
  console.log(`[Server] WebSocket: ws://localhost:${PORT}`);
  console.log(`[Server] Firebase persistence: ${isFirebaseEnabled() ? 'ENABLED' : 'DISABLED (in-memory mode)'}`);
});
