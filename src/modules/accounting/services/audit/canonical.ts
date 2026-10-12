/**
 * Canonical JSON and hashes for audit snapshots and check runs (forensic-
 * controls step 4). One spelling per value, so a hash computed when the
 * snapshot is taken can be recomputed from the stored rows years later:
 *  - object keys in code-point order, at every depth;
 *  - amounts are decimal STRINGS (Postgres numeric::text), never JS numbers —
 *    a float would not survive the round trip through JSONB and JSON.parse;
 *  - integers (counts) are allowed as numbers; any other number is refused;
 *  - undefined members are dropped (as JSON.stringify drops them), null kept.
 */
import { createHash } from 'crypto';

export type Canonical = null | boolean | string | number | Canonical[] | { [k: string]: Canonical | undefined };

export class CanonicalValueError extends Error {
  constructor(path: string, why: string) {
    super(`canonical JSON: ${why} at ${path || '<root>'}`);
    this.name = 'CanonicalValueError';
  }
}

function encode(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'string': return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) throw new CanonicalValueError(path, `${value} is not a safe integer (amounts are decimal strings)`);
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(',')}]`;
      if (value instanceof Date) throw new CanonicalValueError(path, 'a Date (timestamps are strings formatted by the database)');
      const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${encode((value as Record<string, unknown>)[k], `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new CanonicalValueError(path, `a ${typeof value}`);
  }
}

/** The one spelling of `value`; throws CanonicalValueError on anything that would not round-trip. */
export function canonicalJson(value: unknown): string {
  return encode(value, '');
}

export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A row's material hash: SHA-256 of its canonical JSON. */
export function materialHash(row: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(row));
}
