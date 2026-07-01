import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import type { JwtPayload } from '../types';

// Augment Express Request with the authenticated user.
declare module 'express-serve-static-core' {
  interface Request {
    user?: JwtPayload;
  }
}

// Require a valid Bearer JWT on the request. Attaches the decoded payload to
// req.user, or responds 401. Applied to every protected route.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
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
  req.user = payload;
  next();
}
