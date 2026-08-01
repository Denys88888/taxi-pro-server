import { z } from 'zod';
import { store } from '../models';
import { logger } from '../utils/logger';
import { pushToUser } from '../services/fcmService';
import { calculateFare } from '../services/fareCalculator';
import { getRouteInfo } from '../services/routingService';
import { getSurge } from '../services/surgeService';
import { genId, nowIso, haversineKm, isApprovedDriver } from '../utils/helpers';
import { MAX_MESSAGE_LENGTH } from '../config/constants';
import { send, sendToUser, broadcast, broadcastToDriversOfType, type AuthedSocket } from './broadcast';
import { initialOffered } from '../services/scheduler';

const acceptingRides = new Set<string>();
import type { Ride, GeoPoint } from '../types';

const geo = z.object({
  lat: z.number(),
  lng: z.number(),
  address: z.string().optional(),
});
const vehicle = z.enum(['economy', 'comfort', 'business', 'xl']);

// Per-connection chat rate limit: 1 message / 2s (Rule / spec).
function chatRateLimited(ws: AuthedSocket): boolean {
  const now = Date.now();
  if (ws.lastMessageAt && now - ws.lastMessageAt < 2000) return true;
  ws.lastMessageAt = now;
  return false;
}

function rideIdFromChat(chatId: string): string {
  return chatId.replace(/^chat_/, '');
}

// Deliver a payload to both participants of a ride.
function notifyRideParties(ride: Ride, payload: unknown): void {
  sendToUser(ride.passengerId, payload);
  if (ride.driverId) sendToUser(ride.driverId, payload);
}

// Dispatch a single decoded client message. `ws` is already authenticated.
// Generic per-connection flood guard. The chat path has its own 1-msg/2s limit;
// this stops a client spamming any *other* message type (driver_location,
// ride_request, offers) thousands of times a second to exhaust the process.
// ping (cheap heartbeat) and the call_* signaling (WebRTC emits ICE candidates
// in bursts while connecting) are exempt so normal traffic is never throttled.
const WS_FLOOD_WINDOW_MS = 1000;
const WS_FLOOD_MAX = 40; // generous: driver_location is ~1/3s, this only trips on abuse
const WS_FLOOD_KILL = 200; // sustained flood at this rate = malicious, drop the socket
const FLOOD_EXEMPT = new Set(['ping', 'call_offer', 'call_answer', 'call_ice', 'call_end', 'call_decline']);

function floodLimited(ws: AuthedSocket, type: string): boolean {
  if (FLOOD_EXEMPT.has(type)) return false;
  const now = Date.now();
  if (!ws.msgWindowStart || now - ws.msgWindowStart > WS_FLOOD_WINDOW_MS) {
    ws.msgWindowStart = now;
    ws.msgCount = 0;
  }
  ws.msgCount = (ws.msgCount ?? 0) + 1;
  if (ws.msgCount > WS_FLOOD_KILL) {
    logger.warn('[WS] flood — terminating socket', { uid: ws.userId, count: ws.msgCount });
    ws.terminate();
    return true;
  }
  return ws.msgCount > WS_FLOOD_MAX;
}

export async function handleMessage(ws: AuthedSocket, msg: Record<string, unknown>): Promise<void> {
  const type = String(msg.type ?? '');
  const uid = ws.userId!;

  if (floodLimited(ws, type)) return;

  switch (type) {
    case 'ping': {
      send(ws, { type: 'pong', time: Date.now() });
      return;
    }

    case 'driver_online': {
      const p = geo.parse(msg);
      const v = msg.vehicleType ? vehicle.parse(msg.vehicleType) : undefined;
      const user = await store().getUser(uid);
      if (!user || user.role !== 'driver' || !user.driverInfo) {
        send(ws, { type: 'error', message: 'Not a registered driver', code: 'NOT_DRIVER' });
        return;
      }
      // Same approval gate REST /drivers/online enforces. Without it an
      // unapproved driver could go online over the socket, show up as an
      // available car in /drivers/nearby and receive ride offers they are
      // then refused at ride_accept — a phantom car on the passenger's map.
      if (!isApprovedDriver(user.driverInfo)) {
        send(ws, { type: 'error', message: 'Driver not verified', code: 'NOT_VERIFIED' });
        return;
      }
      if (user.isBlocked) {
        send(ws, { type: 'error', message: 'Account blocked', code: 'BLOCKED' });
        return;
      }
      // Only enforce once the driver has actually been rated a few times —
      // a brand-new driver's default rating must never block their first rides.
      const settings = await store().getSettings();
      if (settings.maintenanceMode) {
        send(ws, { type: 'error', message: 'Ordering is temporarily disabled for maintenance', code: 'MAINTENANCE' });
        return;
      }
      if ((user.ratingCount ?? 0) >= 3 && user.rating < settings.minDriverRating) {
        send(ws, {
          type: 'error',
          message: 'Your rating is below the minimum required to go online',
          code: 'RATING_TOO_LOW',
        });
        return;
      }
      const resolvedVehicleType = v ?? user.driverInfo.vehicleType;
      await store().updateUser(uid, {
        driverInfo: {
          ...user.driverInfo,
          isOnline: true,
          vehicleType: resolvedVehicleType,
          lastLocation: { lat: p.lat, lng: p.lng },
        },
      });
      // Keep the live socket's vehicle class + location in sync so ride
      // dispatch (which filters by ws.vehicleType/ws.driverLocation, not a
      // DB lookup) offers this driver only rides matching what they're
      // actually registered/driving as AND within radius of pickup.
      ws.vehicleType = resolvedVehicleType;
      ws.driverLocation = { lat: p.lat, lng: p.lng };
      ws.driverOnline = true;
      ws.lastLocationAt = Date.now();
      send(ws, { type: 'ride_status_update', rideId: '', status: 'online', data: {} });
      return;
    }

    case 'driver_offline': {
      const user = await store().getUser(uid);
      if (user?.driverInfo) {
        await store().updateUser(uid, {
          driverInfo: { ...user.driverInfo, isOnline: false },
        });
      }
      ws.driverOnline = false;
      send(ws, { type: 'ride_status_update', rideId: '', status: 'offline', data: {} });
      return;
    }

    case 'ride_request': {
      const pickup = geo.parse(msg.pickup) as GeoPoint;
      const destination = geo.parse(msg.destination) as GeoPoint;
      const v = vehicle.parse(msg.vehicleType);
      const settings = await store().getSettings();
      if (settings.maintenanceMode) {
        send(ws, { type: 'error', message: 'Ordering is temporarily disabled for maintenance', code: 'MAINTENANCE' });
        return;
      }
      // Real road distance/duration (haversine only as offline fallback).
      const [{ distanceKm, durationMin }, surge] = await Promise.all([
        getRouteInfo([pickup, destination]),
        settings.surgeEnabled !== false
          ? getSurge(pickup)
          : Promise.resolve({ multiplier: 1, reason: 'normal' as const }),
      ]);
      const breakdown = calculateFare({
        vehicleType: v,
        distanceKm,
        durationMin,
        surge: surge.multiplier,
        platformFeePercent: settings.platformFeePercent,
        minFare: settings.minFare,
        baseFarePerKm: settings.baseFarePerKm,
      });
      const note = typeof msg.note === 'string' ? msg.note.trim().slice(0, 200) : '';
      const ride: Ride = {
        id: genId('ride'),
        passengerId: uid,
        pickup,
        destination,
        ...(note ? { note } : {}),
        vehicleType: v,
        distanceKm: Math.round(distanceKm * 100) / 100,
        estimatedDurationMin: durationMin,
        ...breakdown,
        surgeMultiplier: surge.multiplier,
        paymentStatus: 'pending',
        status: 'searching',
        searchStartedAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await store().saveRide(ride);
      // Offer only to online drivers of a compatible vehicle class AND
      // within maxSearchRadiusKm of pickup. If no one accepts within the
      // offer timeout, the scheduler expands to extendedSearchRadiusKm,
      // excluding drivers we already offered here (see initialOffered).
      const offered = broadcastToDriversOfType(
        { type: 'ride_available', ride },
        v,
        pickup,
        settings.maxSearchRadiusKm
      );
      initialOffered.set(ride.id, new Set(offered));
      send(ws, { type: 'ride_status_update', rideId: ride.id, status: 'searching', data: { ride } });
      return;
    }

    case 'ride_accept': {
      const rideId = String(msg.rideId ?? '');
      if (acceptingRides.has(rideId)) {
        send(ws, { type: 'error', message: 'Ride no longer available', code: 'TAKEN' });
        return;
      }
      acceptingRides.add(rideId);
      try {
      const driver = await store().getUser(uid);
      if (!driver || driver.role !== 'driver' || !driver.driverInfo) {
        send(ws, { type: 'error', message: 'Not a registered driver', code: 'NOT_DRIVER' });
        return;
      }
      if (driver.isBlocked) {
        send(ws, { type: 'error', message: 'Account blocked', code: 'BLOCKED' });
        return;
      }
      if (!isApprovedDriver(driver.driverInfo)) {
        send(ws, { type: 'error', message: 'Driver not verified', code: 'NOT_VERIFIED' });
        return;
      }
      // Off-shift drivers must not take rides. Nothing clears isOnline during a
      // ride, so this only ever catches a driver who really did go offline (or
      // was swept offline for GPS silence) and still had a stale offer on screen.
      if (!driver.driverInfo.isOnline) {
        send(ws, { type: 'error', message: 'You are offline', code: 'OFFLINE' });
        return;
      }
      const ride = await store().getRide(rideId);
      if (!ride) {
        send(ws, { type: 'error', message: 'Ride not found', code: 'NO_RIDE' });
        return;
      }
      if (ride.status !== 'searching') {
        send(ws, { type: 'error', message: 'Ride no longer available', code: 'TAKEN' });
        return;
      }
      const updated = await store().updateRide(rideId, { status: 'assigned', driverId: uid });
      const driverInfo = {
        uid,
        name: driver?.name,
        phone: driver?.phone,
        rating: driver?.rating,
        vehicleType: driver?.driverInfo?.vehicleType,
        brand: driver?.driverInfo?.brand,
        model: driver?.driverInfo?.model,
        color: driver?.driverInfo?.color,
        number: driver?.driverInfo?.number,
        vehiclePhoto: driver?.driverInfo?.vehiclePhoto,
      };
      sendToUser(ride.passengerId, {
        type: 'ride_assigned',
        rideId,
        driverId: uid,
        driverInfo,
      });
      // Tell other drivers it's gone.
      broadcast({ type: 'ride_status_update', rideId, status: 'assigned', data: {} }, 'driver');
      send(ws, { type: 'ride_status_update', rideId, status: 'assigned', data: { ride: updated } });
      await pushToUser(ride.passengerId, 'Driver found!', `${driver?.name ?? 'Your driver'} is on the way.`, {
        type: 'ride_assigned',
        rideId,
      });
      } finally {
        acceptingRides.delete(rideId);
      }
      return;
    }

    case 'ride_decline': {
      // Informational only in the broadcast model; log for analytics.
      logger.info('[WS] ride_declined', { rideId: msg.rideId, uid });
      return;
    }

    case 'ride_arrived':
    case 'ride_started':
    case 'ride_completed': {
      const rideId = String(msg.rideId ?? '');
      const ride = await store().getRide(rideId);
      if (!ride) {
        send(ws, { type: 'error', message: 'Ride not found', code: 'NO_RIDE' });
        return;
      }
      if (ride.driverId !== uid) {
        send(ws, { type: 'error', message: 'Not your ride', code: 'FORBIDDEN' });
        return;
      }
      const statusMap = {
        ride_arrived: 'arrived',
        ride_started: 'in_progress',
        ride_completed: 'completed',
      } as const;
      const validTransitions: Record<string, string[]> = {
        assigned: ['arrived'],
        arrived: ['in_progress'],
        in_progress: ['completed'],
      };
      const status = statusMap[type];
      const allowed = validTransitions[ride.status] ?? [];
      if (!allowed.includes(status)) {
        send(ws, { type: 'error', message: `Cannot transition from ${ride.status} to ${status}`, code: 'INVALID_TRANSITION' });
        return;
      }
      // Stamp arrival time so cancellation can grant the free grace window.
      const updated = await store().updateRide(rideId, {
        status,
        ...(status === 'arrived' ? { arrivedAt: nowIso() } : {}),
      });
      notifyRideParties(updated ?? ride, {
        type: 'ride_status_update',
        rideId,
        status,
        data: {},
      });
      const notif: Record<string, [string, string]> = {
        arrived: ['Driver arrived', 'Your driver is waiting at the pickup point.'],
        in_progress: ['Ride started', 'Enjoy your trip!'],
        completed: ['Ride complete', 'Please rate your driver.'],
      };
      if (notif[status]) {
        await pushToUser(ride.passengerId, notif[status][0], notif[status][1], { rideId, status });
      }
      return;
    }

    case 'driver_location': {
      const rideId = String(msg.rideId ?? '');
      const lat = Number(msg.lat);
      const lng = Number(msg.lng);
      if (Number.isNaN(lat) || Number.isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      // Teleport guard: reject a jump that implies an impossible ground speed
      // (>200 km/h), the signature of a spoofed or garbage GPS fix. Real travel,
      // including motorway speeds, stays well under this; a first fix (no prior)
      // is always accepted.
      const nowLoc = Date.now();
      if (ws.driverLocation && ws.lastLocationAt) {
        const km = haversineKm(ws.driverLocation.lat, ws.driverLocation.lng, lat, lng);
        const hours = (nowLoc - ws.lastLocationAt) / 3_600_000;
        if (hours > 0 && km / hours > 200) {
          logger.warn('[WS] rejected implausible location jump', { uid, kmh: Math.round(km / hours) });
          return;
        }
      }
      ws.lastLocationAt = nowLoc;
      // Update the live socket first (dispatch reads it synchronously),
      // then persist to the store.
      ws.driverLocation = { lat, lng };
      const driver = await store().getUser(uid);
      if (driver?.driverInfo) {
        await store().updateUser(uid, {
          driverInfo: { ...driver.driverInfo, lastLocation: { lat, lng } },
        });
      }
      // rideId is optional: an idle online driver pings location with no ride
      // attached (that ping is what keeps them from being auto-set offline).
      // Looking up an empty document id throws in Firestore, so only resolve
      // the ride when there is one to forward the position to.
      if (rideId) {
        const ride = await store().getRide(rideId);
        if (ride) {
          sendToUser(ride.passengerId, { type: 'driver_location_update', rideId, lat, lng });
        }
      }
      return;
    }

    case 'join_chat': {
      const chatId = String(msg.chatId ?? '');
      ws.chatId = chatId;
      const messages = await store().getMessages(chatId);
      send(ws, { type: 'joined', chatId, messages });
      return;
    }

    case 'send_message': {
      if (chatRateLimited(ws)) {
        send(ws, { type: 'rate_limit', message: 'You are sending messages too fast.' });
        return;
      }
      const chatId = String(msg.chatId ?? '');
      const text = String(msg.text ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!chatId || !text) return;
      const ride = await store().getRide(rideIdFromChat(chatId));
      if (!ride || (ride.passengerId !== uid && ride.driverId !== uid)) {
        send(ws, { type: 'error', message: 'Not a participant of this chat', code: 'FORBIDDEN' });
        return;
      }
      const message = {
        id: genId('msg'),
        chatId,
        senderId: uid,
        senderRole: ws.role!,
        text,
        isTemplate: Boolean(msg.isTemplate),
        timestamp: nowIso(),
      };
      await store().saveMessage(message);
      notifyRideParties(ride, { type: 'new_message', chatId, message });
      const otherId = ride.passengerId === uid ? ride.driverId : ride.passengerId;
      if (otherId) await pushToUser(otherId, 'New message', text.slice(0, 60), { chatId });
      return;
    }

    // ── In-app voice call signaling (WebRTC) ─────────────────────────────────
    // The server only relays SDP/ICE between the two parties of a ride; the
    // media itself flows peer-to-peer and never touches the server. This is how
    // two people talk without either seeing the other's phone number — the
    // tel: link that used to dial the real number is replaced by this.
    case 'call_offer':
    case 'call_answer':
    case 'call_ice':
    case 'call_end':
    case 'call_decline': {
      const rideId = String(msg.rideId ?? '');
      const ride = await store().getRide(rideId);
      if (!ride || (ride.passengerId !== uid && ride.driverId !== uid)) {
        send(ws, { type: 'error', message: 'Not a participant of this ride', code: 'FORBIDDEN' });
        return;
      }
      const otherId = ride.passengerId === uid ? ride.driverId : ride.passengerId;
      if (!otherId) {
        send(ws, { type: 'call_end', rideId, reason: 'no_counterpart' });
        return;
      }
      // A call only makes sense while the ride is live. Starting one on a
      // finished ride would let the parties reach each other indefinitely.
      if (type === 'call_offer' && !['assigned', 'arrived', 'in_progress'].includes(ride.status)) {
        send(ws, { type: 'call_end', rideId, reason: 'ride_inactive' });
        return;
      }
      // Guard against oversized relayed blobs — a normal SDP is a few KB.
      const sdp = typeof msg.sdp === 'string' && msg.sdp.length < 20000 ? msg.sdp : undefined;
      const candidate =
        msg.candidate && JSON.stringify(msg.candidate).length < 4000 ? msg.candidate : undefined;
      const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 40) : undefined;
      const delivered = sendToUser(otherId, { type, rideId, from: uid, sdp, candidate, reason });
      // If the callee has no live socket, don't leave the caller ringing forever.
      if (type === 'call_offer' && !delivered) {
        send(ws, { type: 'call_end', rideId, reason: 'unavailable' });
      }
      return;
    }

    default:
      send(ws, { type: 'error', message: `Unknown message type: ${type}`, code: 'UNKNOWN' });
  }
}
