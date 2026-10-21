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

function safeText(s: string): string {
  return s.replace(/\u0000/g, '').replace(LONE_SURROGATE, '�');
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
