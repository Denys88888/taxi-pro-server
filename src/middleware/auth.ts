import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import { store } from '../models';
import { TtlCache } from '../utils/ttlCache';
import type { JwtPayload, Role } from '../types';

// Augment Express Request with the authenticated user.
declare module 'express-serve-static-core' {
  interface Request {
    user?: JwtPayload;
  }
}

// The block check below runs on every protected request, and a driver on shift
// makes one roughly every four seconds — location, open rides, heatmap, the
// ride they are on. Reading their user document each time made this single
// check the largest consumer of the Firestore quota in the whole app, all to
// re-learn a flag that changes at most once in an account's life.
//
// A minute of staleness is the cost. It buys nothing for the blocked user:
// blocking already severs their socket and cancels their live rides on the
// spot, and the admin path drops this entry the moment it writes the flag, so
// the window only exists for a block applied by a *different* instance.
const BLOCK_CHECK_TTL_MS = 60_000;

interface BlockState {
  isBlocked: boolean;
  blockReason?: string;
  // The role as *stored*, which is not always the role in the token. A JWT is
  // good for 24h, so demoting an admin left them fully admin on every HTTP
  // route until their token happened to expire — blocking them worked, taking
  // the role away did not. The socket path already preferred the stored role
  // (websocket/server.ts); this closes the same gap for HTTP. It costs nothing:
  // the user document is being read here anyway.
  role?: Role;
}

const blockChecks = new TtlCache<BlockState>(BLOCK_CHECK_TTL_MS);

// Called by the admin block paths so a ban takes effect on the next request
// rather than up to a minute later.
export function forgetBlockCheck(uid: string): void {
  blockChecks.invalidate(uid);
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
    const state = await blockChecks.get(payload.uid, async () => {
      const user = await store().getUser(payload.uid);
      return { isBlocked: !!user?.isBlocked, blockReason: user?.blockReason, role: user?.role };
    });
    if (state.isBlocked) {
      res.status(403).json({ error: 'Account blocked', reason: state.blockReason, code: 'BLOCKED' });
      return;
    }
    // The stored role wins over the token's claim, in both directions — the
    // same rule websocket/server.ts already applies. Downwards it is the point
    // of this: a demoted admin must stop being one now, not in 24 hours.
    // Upwards it is what makes a driver approved *after* they logged in work
    // without a re-login, which is the exact case that comment cites.
    //
    // This is only ever a promotion the store itself already granted, and the
    // one role that matters can be granted by nothing but ADMIN_UIDS or another
    // admin (authController + adminController are the only writers).
    if (state.role && state.role !== payload.role) {
      payload.role = state.role;
    }
  } catch {
    /* store unavailable — fall through on the strength of the valid token */
  }
  req.user = payload;
  next();
}
