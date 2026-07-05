import rateLimit from 'express-rate-limit';

// Global API limiter: 100 requests / minute / IP.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
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

// Chat limiter: 1 message / 2 seconds / IP (30 / minute).
export const messageLimiter = rateLimit({
  windowMs: 2 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You are sending messages too fast.' },
});

// Ride creation limiter: 10 rides / 5 minutes / IP (prevents fare-spam abuse).
export const rideCreateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many ride requests. Please wait a moment.' },
});
