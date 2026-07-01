import { env } from '../config/env';
import { PI_API_HOST } from '../config/constants';
import { logger } from '../utils/logger';

// Thin wrapper over the Pi Platform API. Uses the server-side API key (never
// exposed to clients) for payment approve/complete, and the user's accessToken
// for identity verification. All secrets come from env only (Rule: no keys in code).

export interface PiApiResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T;
}

function assertConfigured(): void {
  if (!env.PI_API_KEY) {
    const err = new Error('Pi API key not configured') as Error & { statusCode: number };
    err.statusCode = 503;
    throw err;
  }
}

async function piFetch<T>(
  path: string,
  method: 'GET' | 'POST',
  auth: string,
  body?: unknown
): Promise<PiApiResult<T>> {
  const res = await fetch(`https://${PI_API_HOST}${path}`, {
    method,
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = {} as T;
  }
  return { ok: res.ok, status: res.status, data };
}

// Verify a Pi accessToken by calling /v2/me. Returns { uid, username } or null.
export async function verifyPiAccessToken(
  accessToken: string
): Promise<{ uid: string; username: string } | null> {
  try {
    const { ok, data } = await piFetch<{ uid: string; username: string }>(
      '/v2/me',
      'GET',
      `Bearer ${accessToken}`
    );
    if (!ok || !data.uid) return null;
    return { uid: data.uid, username: data.username };
  } catch (err) {
    logger.error('[Pi] /v2/me failed', { error: (err as Error).message });
    return null;
  }
}

// Server-side approval: tell Pi we accept this payment.
export async function approvePayment(piPaymentId: string): Promise<PiApiResult> {
  assertConfigured();
  return piFetch(
    `/v2/payments/${piPaymentId}/approve`,
    'POST',
    `Key ${env.PI_API_KEY}`
  );
}

// Server-side completion: submit the blockchain txid to finalize.
export async function completePayment(
  piPaymentId: string,
  txid: string
): Promise<PiApiResult> {
  assertConfigured();
  return piFetch(
    `/v2/payments/${piPaymentId}/complete`,
    'POST',
    `Key ${env.PI_API_KEY}`,
    { txid }
  );
}

// Fetch the current state of a payment from Pi.
export async function getPiPayment(piPaymentId: string): Promise<PiApiResult> {
  assertConfigured();
  return piFetch(`/v2/payments/${piPaymentId}`, 'GET', `Key ${env.PI_API_KEY}`);
}
