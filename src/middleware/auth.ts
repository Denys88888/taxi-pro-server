import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import { store } from '../models';
import type { JwtPayload } from '../types';

// Augment Express Request with the authenticated user.
declare module 'express-serve-static-core' {
  interface Request {
    user?: JwtPayload;
  }
}

// Require a valid Bearer JWT on the request. Attaches the decoded payload to
// req.user, or responds 401. Also rejects users blocked AFTER login (their JWT
// stays valid for 24h, so a login-time check alone would let a banned user keep
// acting until the token expires). Applied to every protected route.
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization token' });
    return;
  }
  const payload = verifyToken(header.slice(7));
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  // Positive block check only: if the lookup fails we let the valid JWT through
  // rather than locking everyone out on a transient store error.
  try {
    const user = await store().getUser(payload.uid);
    if (user?.isBlocked) {
      res.status(403).json({ error: 'Account blocked', reason: user.blockReason, code: 'BLOCKED' });
      return;
    }
  } catch {
    /* store unavailable — fall through on the strength of the valid token */
  }
  req.user = payload;
  next();
}
