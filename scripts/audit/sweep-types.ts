/**
 * Shared types for the API contract sweep.
 * scripts/audit/sweep-types.ts
 */

export interface RouteResult {
  route: string;
  method: string;
  scenario: string;
  statusCode: number;
  latencyMs: number;
  envelopeOk: boolean;
  /** Envelope violation detail when envelopeOk=false */
  envelopeError?: string;
  /** True if body contains stack trace, PG error code, or severity field */
  leaksInternals: boolean;
  leakDetail?: string;
  /** Non-null only on actual error responses */
  errorBody?: string;
}

export type Priority = 'P1' | 'P2' | 'P3';

export interface Finding {
  priority: Priority;
  route: string;
  method: string;
  scenario: string;
  statusCode: number;
  latencyMs: number;
  description: string;
  raw?: string;
}

/**
 * Check whether a parsed body conforms to the apiResponse envelope.
 * Accepts:
 *   - { success: true,  data: * }            (success)
 *   - { success: false, error: { code, message } }  (error)
 *   - 204 no-content (body === null / '' treated as OK)
 */
export function checkEnvelope(
  body: unknown,
  statusCode: number,
): { ok: boolean; reason?: string } {
  if (statusCode === 204) return { ok: true };
  if (body === null || body === undefined || body === '') {
    return { ok: false, reason: 'empty body' };
  }
  if (typeof body !== 'object') {
    return { ok: false, reason: `body is ${typeof body}, not object` };
  }
  const b = body as Record<string, unknown>;
  if (typeof b['success'] !== 'boolean') {
    return { ok: false, reason: 'missing boolean "success" field' };
  }
  if (b['success'] === true) {
    if (!('data' in b)) {
      return { ok: false, reason: 'success=true but no "data" field' };
    }
    return { ok: true };
  }
  // success === false
  const err = b['error'];
  if (!err || typeof err !== 'object') {
    return { ok: false, reason: 'success=false but no "error" object' };
  }
  const e = err as Record<string, unknown>;
  if (typeof e['code'] !== 'string' || typeof e['message'] !== 'string') {
    return { ok: false, reason: 'error object missing "code" or "message"' };
  }
  return { ok: true };
}

/**
 * Detect PG error leaks or stack traces in a response body.
 */
export function detectLeaks(body: unknown): { leaks: boolean; detail?: string } {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');

  // PG error field names
  if (/"severity"\s*:\s*"(ERROR|FATAL|PANIC)"/.test(text)) {
    return { leaks: true, detail: 'PG severity field exposed' };
  }
  // PG error codes: 5-char codes containing at least one digit and one letter (e.g. 42P18, 23505 only if
  // part of PG-style error object with severity nearby). Pure digit codes like "23505" can appear in
  // data fields so we only flag when it's adjacent to a PG severity/detail keyword to reduce false positives.
  if (/"code"\s*:\s*"[0-9A-Z]{5}"/.test(text) && /"(severity|detail|hint|position|where|schema|table|column|constraint)"\s*:/.test(text)) {
    return { leaks: true, detail: 'PG error object exposed (code + pg metadata fields)' };
  }
  // Stack traces
  if (/\bat\s+\w+\s+\(.*:\d+:\d+\)/.test(text)) {
    return { leaks: true, detail: 'Stack trace in response body' };
  }
  // Raw SQL leakage
  if (/\bSELECT\b.*\bFROM\b/i.test(text) && text.length < 2000) {
    return { leaks: true, detail: 'Raw SQL in response body' };
  }
  return { leaks: false };
}
