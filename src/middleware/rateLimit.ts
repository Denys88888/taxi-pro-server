import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

// Key per authenticated user, falling back to IP for anonymous requests.
//
// Keying purely by IP punishes people for sharing one: mobile carriers put many
// subscribers behind a single public address (CGNAT), and this app's users are
// overwhelmingly on phones. With a per-IP chat limit of one message per two
// seconds, two riders on the same carrier would silently throttle each other.
// It also removes the dependency on `trust proxy` being exactly right for
// requests we can attribute to a real account.
//
// The IP fallback matches what the library would have used by default, so
// anonymous traffic is limited exactly as before.
const byUserOrIp = (req: Request): string => req.user?.uid ?? req.ip ?? 'unknown';

// Global API limiter: 100 requests / minute.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // Mounted at the /api root, ahead of route-level auth, so this one is
  // effectively per-IP — req.user isn't populated yet.
  keyGenerator: byUserOrIp,
  message: { error: 'Too many requests. Please slow down.' },
});

// Auth limiter: 10 login attempts / minute / IP.
export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Try again shortly.' },
});

// Chat limiter: 1 message / 2 seconds per sender. Runs after requireAuth, so
// this keys by uid — the case where per-IP keying hurt most.
export const messageLimiter = rateLimit({
  windowMs: 2 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byUserOrIp,
  message: { error: 'You are sending messages too fast.' },
});

// Ride creation limiter: 10 rides / 5 minutes per rider (prevents fare-spam).
export const rideCreateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byUserOrIp,
  message: { error: 'Too many ride requests. Please wait a moment.' },
});
