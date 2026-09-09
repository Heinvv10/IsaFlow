/**
 * Netcash Integration Service
 * South African payment gateway — EFT batch payments and debit order collections.
 * Real API: https://api.netcash.co.za/
 * Auth: ServiceKey header
 *
 * NOTE: This service requires valid Netcash API credentials.
 * Submission is owned by the immutable payment release dispatcher.
 * Register at https://www.netcash.co.za to obtain keys.
 */

import { log } from '@/lib/logger';

const NETCASH_BASE_URL = 'https://api.netcash.co.za';
const REQUEST_TIMEOUT_MS = 30_000;

export interface NetcashPayment {
  accountHolder: string;
  bankCode: string;
  accountNumber: string;
  amount: number;       // in cents
  reference: string;
}

export interface NetcashSubmitResult {
  success: boolean;
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

/** Legacy primitive is closed: only the committed release dispatcher may transmit money. */
export async function submitEftBatch(
  _serviceKey: string, _payoutsKey: string, _payments: NetcashPayment[],
): Promise<NetcashSubmitResult> {
  throw new Error('A committed authorized payment release is required');
}

/**
 * Poll the status of a previously submitted Netcash batch.
 */
export async function getSubmissionStatus(
  serviceKey: string,
  batchReference: string,
): Promise<NetcashStatusResult> {
  if (!serviceKey) {
    return { status: 'unknown', detail: 'Provider credentials are unavailable' };
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
