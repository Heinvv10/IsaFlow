/**
 * Netcash Integration Service
 * South African payment gateway — EFT batch payments and debit order collections.
 * Real API: https://api.netcash.co.za/
 * Auth: ServiceKey header
 *
 * NOTE: This service requires valid Netcash API credentials.
 * submitEftBatch refuses without credentials (K-132); the status poll and connection test still answer a mock when no key is set.
 * Register at https://www.netcash.co.za to obtain keys.
 */

import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { REQUEST_TIMEOUT_MS } from './netcashTimeouts';
import type { SendFence } from './netcashSendFence';

const NETCASH_BASE_URL = 'https://api.netcash.co.za';
/** The only HTTP statuses that prove Netcash queued nothing: it refused the batch's fields. */
const REJECTION_STATUSES = new Set([400, 422]);

export interface NetcashPayment {
  accountHolder: string;
  bankCode: string;
  accountNumber: string;
  amount: number;       // in cents
  reference: string;
}

/**
 * What is known about a submission once the request is out:
 *  - accepted: Netcash answered 2xx with a JSON body.
 *  - rejected: Netcash definitely refused it: a 400 or 422 JSON answer (field validation) — nothing was queued,
 *              resubmitting is safe. No other status proves that (409 may mean "already received"; 401/403/404/429
 *              and the rest say nothing of the batch), and Netcash's documented status semantics are not in this repo.
 *  - unknown:  indeterminate — timeout/abort, network error, an unparseable answer or a 5xx. The batch may have been
 *              accepted, so it must NOT be resubmitted until Netcash has been checked.
 */
export type NetcashSubmitOutcome = 'accepted' | 'rejected' | 'unknown';

export interface NetcashSubmitResult {
  success: boolean;
  outcome: NetcashSubmitOutcome;
  batchReference?: string;
  error?: string;
  mock?: boolean;
  /** The sender-side fence refused the send (residual 3b): nothing was sent. `outcome` is then 'rejected'. */
  fenced?: true;
}

export interface NetcashStatusResult {
  status: string;
  detail: string;
  /** Netcash gave a status. false for no key, an HTTP error, a network error, an unreadable body or no status: `status`
   *  is then 'unknown', which is not Netcash's answer and must not be applied (AP-01 round 11). */
  answered: boolean;
}

/** Wraps fetch with a hard 30-second timeout */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The fence refused the send: nothing was issued. */
class SendFencedError extends Error {}

/**
 * One request to Netcash with a hard timeout over the WHOLE exchange: the timer stays armed until the body has been
 * read. Clearing it once headers arrived left a stalled body unbounded, so a send could outlast SEND_WINDOW_MS (the
 * time after which a 'pending' claim is presumed dead and an operator may release it). A body read that times out
 * throws, which the caller answers as an unknown outcome. `json` is the body as a JSON object, or null when it is not
 * one (empty, HTML, a bare array/null).
 */
async function fetchJsonWithTimeout(url: string, init: RequestInit, fence?: Pick<SendFence, 'mayStart'>): Promise<{ res: Response; json: Record<string, unknown> | null }> {
  // The last step before the request, synchronous (nothing can pause between this check and fetch() being called).
  if (fence && !fence.mayStart()) throw new SendFencedError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    try {
      const parsed: unknown = JSON.parse(text);
      return { res, json: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null };
    } catch {
      return { res, json: null }; // not JSON: the caller decides what an unreadable answer means
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Submit an EFT batch payment to Netcash.
 * Refuses (nothing sent) when either API key is absent, or when `fence` (REQUIRED: the sender's, taken before its claim) says the
 * send has waited too long to start safely (residual 3b): `{ outcome: 'rejected', fenced: true }`, nothing sent.
 */
export async function submitEftBatch(
  serviceKey: string,
  payoutsKey: string,
  payments: NetcashPayment[],
  fence: Pick<SendFence, 'mayStart'>,
): Promise<NetcashSubmitResult> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  if (!serviceKey.trim() || !payoutsKey.trim()) {
    // K-132: a missing secret is an error, never a sandbox - the old mock success recorded a payment run that never
    // left. Nothing is sent, so the refusal is definite.
    log.error('Netcash EFT submit called without API keys - refused', {}, 'netcash');
    return { success: false, outcome: 'rejected', error: 'Netcash credentials are not configured' };
  }

  const body = {
    serviceKey,
    payoutsKey,
    payments: payments.map(p => ({
      accountHolder: p.accountHolder,
      bankCode: p.bankCode,
      accountNumber: p.accountNumber,
      amountCents: p.amount,
      reference: p.reference,
    })),
  };

  try {
    const { res, json } = await fetchJsonWithTimeout(`${NETCASH_BASE_URL}/v1/eft/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ServiceKey': serviceKey,
      },
      body: JSON.stringify(body),
    }, fence);

    if (!res.ok) {
      log.error('Netcash EFT submit failed', { status: res.status, body: json }, 'netcash');
      if (json && REJECTION_STATUSES.has(res.status)) {
        return { success: false, outcome: 'rejected', error: String(json.message ?? 'Netcash API error') };
      }
      return { success: false, outcome: 'unknown', error: String(json?.message ?? `Netcash answered HTTP ${res.status}`) };
    }
    if (!json) {
      log.error('Netcash EFT submit answered 2xx with an unreadable body', { status: res.status }, 'netcash');
      return { success: false, outcome: 'unknown', error: 'Netcash answered but the response could not be read' };
    }

    log.info('Netcash EFT batch submitted', { batchReference: json.batchReference, count: payments.length }, 'netcash');
    return { success: true, outcome: 'accepted', batchReference: String(json.batchReference ?? '') };
  } catch (err) {
    if (err instanceof SendFencedError) {
      return { success: false, outcome: 'rejected', fenced: true, error: 'Not sent: the send started too late to be safe' };
    }
    // The request may already have left (timeout/abort, reset connection): the outcome is not known.
    const msg = err instanceof Error ? err.message : 'Network error';
    log.error('Netcash EFT submit exception', { error: msg }, 'netcash');
    return { success: false, outcome: 'unknown', error: msg };
  }
}

/**
 * Poll the status of a previously submitted Netcash batch.
 */
export async function getSubmissionStatus(
  serviceKey: string,
  batchReference: string,
): Promise<NetcashStatusResult> {
  // No mock answer (AP-01 round 10): a made-up 'processing' moved accepted rows and was stored as Netcash's answer.
  // netcash/status does not call this without a key; 'unknown' is what an unanswered poll is.
  if (!serviceKey) {
    log.warn('Netcash status poll called without service key - nothing polled', {}, 'netcash');
    return { status: 'unknown', detail: 'Netcash service key is not configured', answered: false };
  }

  try {
    const url = `${NETCASH_BASE_URL}/v1/eft/status?batchReference=${encodeURIComponent(batchReference)}`;
    // Bounded through the body, like the submit: a poll that stalls must not hold a request (and its row) open.
    const { res, json } = await fetchJsonWithTimeout(url, {
      method: 'GET',
      headers: { 'X-ServiceKey': serviceKey },
    });

    if (!res.ok) {
      log.error('Netcash status poll failed', { status: res.status, batchReference }, 'netcash');
      return { status: 'unknown', detail: String(json?.message ?? 'Status poll failed'), answered: false };
    }
    if (!json) return { status: 'unknown', detail: 'Netcash answered but the response could not be read', answered: false };
    if (typeof json.status !== 'string' || json.status.trim() === '') {
      return { status: 'unknown', detail: 'Netcash answered without a status', answered: false };
    }

    return {
      status: json.status,
      detail: String(json.detail ?? ''),
      answered: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error';
    log.error('Netcash status poll exception', { error: msg, batchReference }, 'netcash');
    return { status: 'unknown', detail: msg, answered: false };
  }
}

/**
 * Test connectivity / validate service key.
 * Returns { valid: true } on success or { valid: false, error } on failure.
 */
export async function testConnection(
  serviceKey: string,
): Promise<{ valid: boolean; error?: string; mock?: boolean }> {
  if (!serviceKey) {
    return { valid: false, error: 'Service key is required', mock: true };
  }

  try {
    const res = await fetchWithTimeout(`${NETCASH_BASE_URL}/v1/account/validate`, {
      method: 'GET',
      headers: { 'X-ServiceKey': serviceKey },
    });

    if (res.ok) {
      log.info('Netcash connection test succeeded', {}, 'netcash');
      return { valid: true };
    }
    return { valid: false, error: `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Connection failed';
    log.warn('Netcash connection test failed — likely no real credentials', { error: msg }, 'netcash');
    // Treat network errors as mock-valid in dev (no real credentials available)
    return { valid: false, error: msg, mock: true };
  }
}
