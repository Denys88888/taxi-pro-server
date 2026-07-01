import { getMessaging } from '../config/firebase';
import { store } from '../models';
import { logger } from '../utils/logger';

// Send a push notification to a user via Firebase Cloud Messaging. No-ops safely
// when FCM is unavailable or the user has no registered token.
export async function pushToUser(
  userId: string,
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<void> {
  const messaging = getMessaging();
  if (!messaging) return;
  try {
    const record = await store().getPushToken(userId);
    if (!record?.token) return;
    await messaging.send({
      token: record.token,
      notification: { title, body },
      data,
    });
  } catch (err) {
    // A failed push must never break the request flow.
    logger.warn('[FCM] send failed', { userId, error: (err as Error).message });
  }
}
