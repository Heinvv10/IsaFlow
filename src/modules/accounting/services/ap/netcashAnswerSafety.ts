/**
 * Netcash's answer, made safe to write (AP-01 round 15). The settle must never fail on the content of the answer it
 * records: a reference longer than netcash_submissions.batch_reference (varchar(100)) failed every settle attempt,
 * the durable record and the late settler with 22001, and the row stayed freeable. Every value taken from Netcash's
 * answer goes through here before it reaches a column:
 *   - the reference goes into a varchar(100) column only when it is text of at most 100 characters with no NUL (no
 *     text column takes one); otherwise that column gets NULL - not a truncation, which status.ts would poll and the
 *     page would link as if it were Netcash's - and the reference stays whole in the JSONB beside it;
 *   - anything bound for JSONB has its NULs removed and lone UTF-16 surrogates replaced (jsonb rejects both: 22P05).
 */

/** The longest reference netcash_submissions.batch_reference and audit_log.entity_ref take. */
export const REFERENCE_COLUMN_LENGTH = 100;

/** The reference if a varchar(100) column takes it as it is, else null (it is kept whole in the JSONB). */
export function safeReference(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  if (ref.length > REFERENCE_COLUMN_LENGTH || ref.includes('\u0000')) return null;
  return ref;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The longest reference sent back to Netcash's API (a query parameter) when the column could not hold it. */
export const API_REFERENCE_LENGTH = 1024;

const UNUSABLE_FOR_API = /[\u0000-\u001f\u007f\ufffd]/;

/**
 * A reference kept in netcash_response (round 16), usable to ask Netcash about the batch: text of 1 to
 * API_REFERENCE_LENGTH characters with no control character and no U+FFFD (jsonSafe may have put one where a lone
 * surrogate was: no longer Netcash's reference), and no lone surrogate (encodeURIComponent throws on one). Else null.
 */
export function apiReference(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > API_REFERENCE_LENGTH) return null;
  if (UNUSABLE_FOR_API.test(ref)) return null;
  LONE_SURROGATE.lastIndex = 0;
  return LONE_SURROGATE.test(ref) ? null : ref;
}

/** An answer from Netcash's send: did Netcash accept it (and so issue its batchReference)? */
interface SendAnswer { success?: unknown; outcome?: unknown; mock?: unknown; batchReference?: unknown }
const accepted = (a: SendAnswer | null | undefined): boolean =>
  // outcome is AP-01's; a row written before it has only success (a mock success was never Netcash's). An absent field
  // may arrive as null (status.ts builds the object in SQL).
  Boolean(a) && a!.mock !== true && (a!.outcome === 'accepted' || (a!.outcome == null && a!.success === true));

/**
 * The reference to poll or link a submission by (round 17): ONLY one Netcash itself issued - the batchReference of an
 * ACCEPTED send answer kept in netcash_response (top level, or lateSendResult.response for an answer that came late),
 * if usable for the API. Never the batch_reference column on its own: after an 'unknown' answer (and from the claim
 * on) it holds OUR batch number, and a poll by it asks Netcash about a reference it never gave us ("Successful" would
 * complete the row, "not found" would flag a batch the operator attested Netcash has). null: no Netcash reference.
 */
export function netcashReferenceOf(netcashResponse: unknown): string | null {
  const r = (netcashResponse ?? {}) as SendAnswer & { lateSendResult?: { response?: SendAnswer | null } | null };
  if (accepted(r)) return apiReference(r.batchReference);
  const late = r.lateSendResult?.response;
  return accepted(late) ? apiReference(late?.batchReference) : null;
}

function safeText(s: string): string {
  return s.replace(/\u0000/g, '').replace(LONE_SURROGATE, '\ufffd');
}

/** `value` with every string (keys too) made safe for jsonb. */
export function jsonSafe<T>(value: T): T {
  if (typeof value === 'string') return safeText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [safeText(k), jsonSafe(v)])) as T;
  }
  return value;
}
