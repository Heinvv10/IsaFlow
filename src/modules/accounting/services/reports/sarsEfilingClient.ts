/**
 * SARS eFiling ISV transport client.
 *
 * Speaks the PROVISIONAL SARS ISV VAT201 contract: activation-key auth ->
 * submit -> poll. Pure transport — takes an already-validated EfilingConfig
 * (see sarsEfilingConfig.ts), holds no DB or env state, so the contract tests
 * can drive it against an in-process mock server over real fetch.
 *
 * ⚠ PROVISIONAL WIRE FORMAT. The real SARS VAT201 ISV interface spec is NOT
 * public — SARS releases it to a vendor only after ISV onboarding + acceptance
 * testing (dossier §1c/§2b). The endpoint paths, auth handshake, and the
 * VAT201 field payload below are modelled on the documented activation-key
 * mechanism (and behave async/batch — submit returns a correlationId you poll,
 * matching Konsise's overnight-processing behaviour). Two known reconciliation
 * points once the spec lands: (1) the canonical VAT201 carries Fields 1–20
 * (incl. 1A/2A/14A/15A splits) whereas generateVAT201 currently produces the
 * simplified field1..field11 set — the fields map is passed through verbatim
 * and remapped then; (2) real submissions may be SOAP/XML rather than JSON.
 * All confined to this one file so adapting is a single-file change.
 */

import { log } from '@/lib/logger';

export interface EfilingConfig {
  baseUrl: string;
  isvLogin: string;
  activationKey: string;
}

export interface EfilingAuth {
  token: string;
  expiresIn?: number;
}

export interface SubmitVAT201Payload {
  /** 10-digit VAT reference starting with 4. */
  vatNumber: string;
  /** Tax period, CCYYMM. */
  taxPeriod: string;
  /** VAT201 box totals (the generateVAT201 field1..field11 shape). */
  fields: Record<string, number>;
}

export interface SubmitResult {
  correlationId: string;
  status: string;
  httpStatus: number;
}

export interface PollResult {
  status: string;
  sarsReference: string | null;
  errors: string[];
  httpStatus: number;
}

/** Transport-level failure (network, non-2xx, unparseable). Business statuses
 *  like 'rejected' are NOT errors — they come back on a 200 from pollStatus. */
export class EfilingTransportError extends Error {
  readonly httpStatus: number;
  readonly bodySnippet: string;
  constructor(message: string, httpStatus: number, bodySnippet = '') {
    super(message);
    this.name = 'EfilingTransportError';
    this.httpStatus = httpStatus;
    this.bodySnippet = bodySnippet;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function parseJson(res: Response): Promise<{ parsed: unknown; text: string }> {
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* non-JSON body; error path uses raw text */ }
  }
  return { parsed, text };
}

export async function authenticate(config: EfilingConfig): Promise<EfilingAuth> {
  const res = await fetch(joinUrl(config.baseUrl, '/auth'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ isvLogin: config.isvLogin, activationKey: config.activationKey }),
  });
  const { parsed, text } = await parseJson(res);
  if (!res.ok) {
    // Never log the activation key. Login is a non-secret identifier.
    log.error('SARS eFiling auth failed', { httpStatus: res.status, isvLogin: config.isvLogin }, 'sarsEfilingClient');
    throw new EfilingTransportError(`SARS eFiling auth failed (HTTP ${res.status})`, res.status, text.slice(0, 300));
  }
  const token = (parsed as { token?: string })?.token;
  if (!token) throw new EfilingTransportError('SARS eFiling auth returned no token', res.status, text.slice(0, 300));
  return { token, expiresIn: (parsed as { expiresIn?: number })?.expiresIn };
}

export async function submitVAT201(
  config: EfilingConfig,
  token: string,
  payload: SubmitVAT201Payload,
): Promise<SubmitResult> {
  const res = await fetch(joinUrl(config.baseUrl, '/vat201'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const { parsed, text } = await parseJson(res);
  if (!res.ok) {
    log.error('SARS eFiling VAT201 submit failed', { httpStatus: res.status }, 'sarsEfilingClient');
    throw new EfilingTransportError(`SARS eFiling submit failed (HTTP ${res.status})`, res.status, text.slice(0, 300));
  }
  const obj = (parsed ?? {}) as { correlationId?: string; status?: string };
  if (!obj.correlationId) {
    throw new EfilingTransportError('SARS eFiling submit returned no correlationId', res.status, text.slice(0, 300));
  }
  return { correlationId: obj.correlationId, status: obj.status ?? 'received', httpStatus: res.status };
}

export async function pollStatus(
  config: EfilingConfig,
  token: string,
  correlationId: string,
): Promise<PollResult> {
  const res = await fetch(joinUrl(config.baseUrl, `/vat201/${encodeURIComponent(correlationId)}`), {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  const { parsed, text } = await parseJson(res);
  if (!res.ok) {
    log.error('SARS eFiling status poll failed', { httpStatus: res.status, correlationId }, 'sarsEfilingClient');
    throw new EfilingTransportError(`SARS eFiling status poll failed (HTTP ${res.status})`, res.status, text.slice(0, 300));
  }
  const obj = (parsed ?? {}) as { status?: string; sarsReference?: string; errors?: string[] };
  return {
    status: obj.status ?? 'unknown',
    sarsReference: obj.sarsReference ?? null,
    errors: Array.isArray(obj.errors) ? obj.errors : [],
    httpStatus: res.status,
  };
}
