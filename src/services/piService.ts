import fetch from 'cross-fetch';
import * as StellarSdk from 'stellar-sdk';
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

// Server-side cancellation: release an approved-but-uncompleted payment
// (escrow refund path — the user's Pi is never captured).
export async function cancelPayment(piPaymentId: string): Promise<PiApiResult> {
  assertConfigured();
  return piFetch(
    `/v2/payments/${piPaymentId}/cancel`,
    'POST',
    `Key ${env.PI_API_KEY}`
  );
}

// Fetch the current state of a payment from Pi.
export async function getPiPayment<T = Record<string, unknown>>(
  piPaymentId: string
): Promise<PiApiResult<T>> {
  assertConfigured();
  return piFetch<T>(`/v2/payments/${piPaymentId}`, 'GET', `Key ${env.PI_API_KEY}`);
}

// ---------------------------------------------------------------------------
// App-to-User (A2U) payouts — sending the driver's real share of the fare out
// of the app's own Pi wallet. This is the only way money ever leaves the app
// wallet: Pi's client SDK (window.Pi.createPayment) is always User-to-App, so
// without this, 100% of every fare/tip sits in the developer wallet forever.
// ---------------------------------------------------------------------------

interface A2UCreateResponse {
  identifier: string;
  to_address: string;
  amount: number;
}

function assertPayoutConfigured(): void {
  assertConfigured();
  if (!env.PI_WALLET_SEED) {
    const err = new Error('Pi wallet seed not configured — payouts disabled') as Error & {
      statusCode: number;
    };
    err.statusCode = 503;
    throw err;
  }
}

// Ask Pi to create a server-initiated payment to a specific user (uid). Pi
// returns the destination Stellar address for that user's wallet.
async function createA2UPayment(
  uid: string,
  amount: number,
  memo: string,
  metadata: Record<string, unknown>
): Promise<A2UCreateResponse> {
  assertConfigured();
  const { ok, status, data } = await piFetch<A2UCreateResponse>(
    '/v2/payments',
    'POST',
    `Key ${env.PI_API_KEY}`,
    { payment: { amount, memo, metadata, uid } }
  );
  if (!ok) {
    throw new Error(`Pi A2U payment create failed (${status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// Build, sign, and submit the actual Stellar transaction moving Pi from the
// app's wallet to the recipient address Pi gave us, memo-tagged with Pi's
// payment identifier so Pi can match it back to the payment record.
async function submitStellarPayment(
  toAddress: string,
  amount: number,
  paymentIdentifier: string
): Promise<string> {
  const server = new StellarSdk.Horizon.Server(env.PI_HORIZON_URL);
  const sourceKeypair = StellarSdk.Keypair.fromSecret(env.PI_WALLET_SEED!);
  let account;
  try {
    account = await server.loadAccount(sourceKeypair.publicKey());
  } catch (err) {
    const horizonData = (err as { response?: { data?: unknown } }).response?.data;
    throw new Error(
      `Stellar loadAccount failed for ${sourceKeypair.publicKey()}: ${horizonData ? JSON.stringify(horizonData) : (err as Error).message}`
    );
  }
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: env.PI_NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: toAddress,
        asset: StellarSdk.Asset.native(),
        amount: amount.toFixed(7),
      })
    )
    .addMemo(StellarSdk.Memo.text(paymentIdentifier))
    .setTimeout(180)
    .build();
  tx.sign(sourceKeypair);
  try {
    const result = await server.submitTransaction(tx);
    return result.hash;
  } catch (err) {
    // Horizon's real rejection reason (e.g. destination account doesn't
    // exist, underfunded source, bad sequence number) lives in
    // response.data.extras — the raw error's top-level message is just the
    // generic "Request failed with status code 400".
    const horizonData = (err as { response?: { data?: unknown } }).response?.data;
    throw new Error(
      `Stellar submitTransaction failed: ${horizonData ? JSON.stringify(horizonData) : (err as Error).message}`
    );
  }
}

// Full A2U payout flow: create the Pi payment, move the Stellar funds, tell
// Pi it's done. Returns the txid on success, throws on any failure so the
// caller can mark the payout 'failed' and retry later without double-paying
// (each call creates a fresh Pi payment identifier, so retries are safe).
export async function payoutToUser(
  uid: string,
  amount: number,
  memo: string,
  metadata: Record<string, unknown>
): Promise<{ piPaymentId: string; txid: string }> {
  assertPayoutConfigured();
  // Unlike U2A payments, A2U payments are approved by Pi automatically at
  // creation time (confirmed via Pi's own error: calling /approve on one
  // returns 400 "already_approved" — there's no separate approval step for
  // the app to perform here). Go straight to the Stellar transfer.
  const created = await createA2UPayment(uid, amount, memo, metadata);
  const txid = await submitStellarPayment(created.to_address, amount, created.identifier);
  const completeResult = await piFetch(
    `/v2/payments/${created.identifier}/complete`,
    'POST',
    `Key ${env.PI_API_KEY}`,
    { txid }
  );
  if (!completeResult.ok) {
    logger.error('[Pi] A2U complete call failed after real Stellar transfer', {
      piPaymentId: created.identifier,
      txid,
      status: completeResult.status,
    });
    // The transfer already happened on-chain — surface the txid so the caller
    // can still record it, even though Pi's own bookkeeping call failed.
    throw Object.assign(new Error('Pi A2U complete failed'), { txid, piPaymentId: created.identifier });
  }
  return { piPaymentId: created.identifier, txid };
}
