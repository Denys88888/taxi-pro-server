import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { JWT_EXPIRY, SHARE_TOKEN_EXPIRY } from '../config/constants';
import type { JwtPayload } from '../types';

// Sign a 24h session token (HS256).
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRY,
  });
}

// Verify a session token. Returns the payload, or null when missing/invalid/expired.
export function verifyToken(token?: string): JwtPayload | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string') return null;
    return decoded as JwtPayload;
  } catch {
    return null;
  }
}

// Short-lived, read-only token for public ride sharing.
export function signShareToken(rideId: string): string {
  return jwt.sign({ rideId, readonly: true }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: SHARE_TOKEN_EXPIRY,
  });
}

export function verifyShareToken(token: string): { rideId: string } | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { rideId: string };
    return decoded.rideId ? { rideId: decoded.rideId } : null;
  } catch {
    return null;
  }
}
