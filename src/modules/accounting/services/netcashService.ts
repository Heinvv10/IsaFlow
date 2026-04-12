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

/**
 * Submit an EFT batch payment to Netcash.
 * Returns a mock response when API keys are absent (sandbox/dev mode).
 */
export async function submitEftBatch(
  serviceKey: string,
  payoutsKey: string,
  payments: NetcashPayment[],
): Promise<NetcashSubmitResult> {
  if (!serviceKey || !payoutsKey) {
    log.warn('Netcash EFT submit called without API keys — returning mock response', {}, 'netcash');
    return {
      success: true,
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

    const json = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      log.error('Netcash EFT submit failed', { status: res.status, body: json }, 'netcash');
      return { success: false, error: String(json.message ?? 'Netcash API error') };
    }

    log.info('Netcash EFT batch submitted', { batchReference: json.batchReference, count: payments.length }, 'netcash');
    return { success: true, batchReference: String(json.batchReference ?? '') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error';
    log.error('Netcash EFT submit exception', { error: msg }, 'netcash');
    return { success: false, error: msg };
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
