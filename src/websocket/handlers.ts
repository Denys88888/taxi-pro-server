import { z } from 'zod';
import { store } from '../models';
import { logger } from '../utils/logger';
import { pushToUser } from '../services/fcmService';
import { calculateFare } from '../services/fareCalculator';
import { getRouteInfo } from '../services/routingService';
import { getSurge } from '../services/surgeService';
import { genId, nowIso } from '../utils/helpers';
import { MAX_MESSAGE_LENGTH } from '../config/constants';
import { send, sendToUser, broadcast, type AuthedSocket } from './broadcast';
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
export async function handleMessage(ws: AuthedSocket, msg: Record<string, unknown>): Promise<void> {
  const type = String(msg.type ?? '');
  const uid = ws.userId!;

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
      await store().updateUser(uid, {
        driverInfo: {
          ...user.driverInfo,
          isOnline: true,
          vehicleType: v ?? user.driverInfo.vehicleType,
          lastLocation: { lat: p.lat, lng: p.lng },
        },
      });
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
      send(ws, { type: 'ride_status_update', rideId: '', status: 'offline', data: {} });
      return;
    }

    case 'ride_request': {
      const pickup = geo.parse(msg.pickup) as GeoPoint;
      const destination = geo.parse(msg.destination) as GeoPoint;
      const v = vehicle.parse(msg.vehicleType);
      const settings = await store().getSettings();
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
      const ride: Ride = {
        id: genId('ride'),
        passengerId: uid,
        pickup,
        destination,
        vehicleType: v,
        distanceKm: Math.round(distanceKm * 100) / 100,
        estimatedDurationMin: durationMin,
        ...breakdown,
        surgeMultiplier: surge.multiplier,
        paymentStatus: 'pending',
        status: 'searching',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await store().saveRide(ride);
      // Offer to all online drivers of the requested vehicle type.
      broadcast({ type: 'ride_available', ride }, 'driver');
      send(ws, { type: 'ride_status_update', rideId: ride.id, status: 'searching', data: { ride } });
      return;
    }

    case 'ride_accept': {
      const rideId = String(msg.rideId ?? '');
      const ride = await store().getRide(rideId);
      if (!ride) {
        send(ws, { type: 'error', message: 'Ride not found', code: 'NO_RIDE' });
        return;
      }
      if (ride.status !== 'searching') {
        send(ws, { type: 'error', message: 'Ride no longer available', code: 'TAKEN' });
        return;
      }
      const driver = await store().getUser(uid);
      const updated = await store().updateRide(rideId, { status: 'assigned', driverId: uid });
      const driverInfo = {
        uid,
        name: driver?.name,
        rating: driver?.rating,
        ...driver?.driverInfo,
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
      const statusMap = {
        ride_arrived: 'arrived',
        ride_started: 'in_progress',
        ride_completed: 'completed',
      } as const;
      const status = statusMap[type];
      const updated = await store().updateRide(rideId, { status });
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
      if (Number.isNaN(lat) || Number.isNaN(lng)) return;
      const driver = await store().getUser(uid);
      if (driver?.driverInfo) {
        await store().updateUser(uid, {
          driverInfo: { ...driver.driverInfo, lastLocation: { lat, lng } },
        });
      }
      const ride = await store().getRide(rideId);
      if (ride) {
        sendToUser(ride.passengerId, { type: 'driver_location_update', rideId, lat, lng });
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

    default:
      send(ws, { type: 'error', message: `Unknown message type: ${type}`, code: 'UNKNOWN' });
  }
}
