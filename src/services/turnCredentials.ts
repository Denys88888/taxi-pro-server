import { env } from '../config/env';
import { logger } from '../utils/logger';

// Metered's free plan only serves the "standard" global relay — this domain
// is where the app was registered, not a secret (it's the same string every
// client would see in a network request anyway).
const METERED_DOMAIN = 'taxipro.metered.live';

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

// One ride's call comfortably fits in an hour; a short-lived credential also
// limits how long a leaked one would stay usable.
const CREDENTIAL_TTL_SECONDS = 3600;

/**
 * Mints a fresh TURN credential via Metered's REST API and resolves it to the
 * actual relay iceServers array (STUN + TURN over UDP/TCP, ports 80 & 443).
 * Returns null — never throws — when no key is configured or the call fails,
 * so a Metered outage degrades to STUN-only instead of breaking call setup.
 */
export async function fetchTurnIceServers(): Promise<IceServer[] | null> {
  if (!env.METERED_SECRET_KEY) return null;
  try {
    const createRes = await fetch(
      `https://${METERED_DOMAIN}/api/v1/turn/credential?secretKey=${env.METERED_SECRET_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiryInSeconds: CREDENTIAL_TTL_SECONDS, label: 'ride-call' }),
      }
    );
    if (!createRes.ok) {
      logger.warn('[turn] credential create failed', { status: createRes.status });
      return null;
    }
    const { apiKey } = (await createRes.json()) as { apiKey?: string };
    if (!apiKey) return null;

    const iceRes = await fetch(`https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${apiKey}`);
    if (!iceRes.ok) {
      logger.warn('[turn] credentials fetch failed', { status: iceRes.status });
      return null;
    }
    return (await iceRes.json()) as IceServer[];
  } catch (err) {
    logger.warn('[turn] fetchTurnIceServers failed', { error: (err as Error).message });
    return null;
  }
}
