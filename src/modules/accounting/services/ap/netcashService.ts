/**
 * Netcash Integration Service
 * South African payment gateway — EFT batch payments and debit order collections.
 * Real API: https://api.netcash.co.za/
 * Auth: ServiceKey header
 *
 * NOTE: This service requires valid Netcash API credentials.
 * Without credentials it returns structured mock responses.
 * Register at https://www.netcash.co.za to obtain keys.
 */

import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';

const NETCASH_BASE_URL = 'https://api.netcash.co.za';
const REQUEST_TIMEOUT_MS = 30_000;
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
}

export interface NetcashStatusResult {
  status: string;
  detail: string;
  mock?: boolean;
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

/** The response body as a JSON object, or null when it is not one (empty, HTML, a bare array/null). */
async function readJsonObject(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await res.json();
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null; // not JSON: the caller decides what an unreadable answer means
  }
}

/**
 * Submit an EFT batch payment to Netcash.
 * Returns a mock response when API keys are absent (sandbox/dev mode).
 */
export async function submitEftBatch(
  serviceKey: string,
  payoutsKey: string,
  payments: NetcashPayment[],
): Promise<NetcashSubmitResult> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  if (!serviceKey || !payoutsKey) {
    log.warn('Netcash EFT submit called without API keys — returning mock response', {}, 'netcash');
    return {
      success: true,
      outcome: 'accepted',
      batchReference: `MOCK-${Date.now()}`,
      mock: true,
    };
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
    const res = await fetchWithTimeout(`${NETCASH_BASE_URL}/v1/eft/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ServiceKey': serviceKey,
      },
      body: JSON.stringify(body),
    });

    const json = await readJsonObject(res);

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
  if (!serviceKey) {
    log.warn('Netcash status poll called without service key — returning mock', {}, 'netcash');
    return { status: 'processing', detail: 'Mock status — no API key configured', mock: true };
  }

  try {
    const url = `${NETCASH_BASE_URL}/v1/eft/status?batchReference=${encodeURIComponent(batchReference)}`;
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'X-ServiceKey': serviceKey },
    });

    const json = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      log.error('Netcash status poll failed', { status: res.status, batchReference }, 'netcash');
      return { status: 'unknown', detail: String(json.message ?? 'Status poll failed') };
    }

    return {
      status: String(json.status ?? 'unknown'),
      detail: String(json.detail ?? ''),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error';
    log.error('Netcash status poll exception', { error: msg, batchReference }, 'netcash');
    return { status: 'unknown', detail: msg };
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
