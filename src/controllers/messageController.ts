import type { Request, Response } from 'express';
import { store } from '../models';
import { genId, nowIso } from '../utils/helpers';
import { sendToUser } from '../websocket/broadcast';
import { MAX_MESSAGE_LENGTH } from '../config/constants';

// GET /api/messages?chatId=... — chat history for a room the caller belongs to.
export async function getHistory(req: Request, res: Response): Promise<void> {
  const chatId = String(req.query.chatId ?? '');
  if (!chatId) {
    res.status(400).json({ error: 'chatId required' });
    return;
  }
  const rideId = chatId.replace(/^chat_/, '');
  const ride = await store().getRide(rideId);
  if (ride && ride.passengerId !== req.user!.uid && ride.driverId !== req.user!.uid) {
    res.status(403).json({ error: 'Not a participant' });
    return;
  }
  const messages = await store().getMessages(chatId);
  res.json({ chatId, messages });
}

// POST /api/messages — REST fallback for sending a chat message (max 500 chars).
export async function sendMessage(req: Request, res: Response): Promise<void> {
  const { chatId, text, isTemplate } = req.body as {
    chatId: string;
    text: string;
    isTemplate?: boolean;
  };
  const rideId = chatId.replace(/^chat_/, '');
  const ride = await store().getRide(rideId);
  if (!ride || (ride.passengerId !== req.user!.uid && ride.driverId !== req.user!.uid)) {
    res.status(403).json({ error: 'Not a participant' });
    return;
  }
  const message = {
    id: genId('msg'),
    chatId,
    senderId: req.user!.uid,
    senderRole: req.user!.role,
    text: text.trim().slice(0, MAX_MESSAGE_LENGTH),
    isTemplate: Boolean(isTemplate),
    timestamp: nowIso(),
  };
  await store().saveMessage(message);
  // Mirror to the live sockets so REST and WS clients stay in sync.
  sendToUser(ride.passengerId, { type: 'new_message', chatId, message });
  if (ride.driverId) sendToUser(ride.driverId, { type: 'new_message', chatId, message });
  res.status(201).json(message);
}
