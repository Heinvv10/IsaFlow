/**
 * Field readers for the Sage export. PURE. Each returns the value, or pushes a reason into `why` and returns undefined, so a
 * row's parser reports every fault in the row at once. An absent or null optional field is `null`.
 */
import { hasWholeCents } from '@/lib/money/wholeCents';

export type Raw = Record<string, unknown>;

export const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A Sage ID: a positive-looking integer as a number or a digit string. Returned as a string. */
export function readId(o: Raw, key: string, why: string[], required = true): string | null | undefined {
  const v = o[key];
  if (v === undefined || v === null || v === '') {
    if (required) why.push(`${key} is required`);
    return required ? undefined : null;
  }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v !== 0) return String(v);
  if (typeof v === 'string' && /^-?[1-9]\d{0,17}$/.test(v.trim())) return v.trim();
  // 0 is Sage's "none" in places, but this export's meaning is not confirmed: the row is refused, never read as "no such id".
  if (v === 0 || (typeof v === 'string' && /^0+$/.test(v.trim()))) why.push(`${key} is 0: id 0 / empty object: unknown whether Sage means none (the row is refused, not guessed)`);
  else why.push(`${key} must be a Sage numeric id`);
  return undefined;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Why text cannot be stored (Postgres refuses a NUL byte; a lone surrogate would be written as U+FFFD, merging distinct values), or null. */
export function invalidTextProblem(t: string): string | null {
  if (t.includes('\u0000')) return 'a NUL byte';
  if (LONE_SURROGATE.test(t)) return 'a lone surrogate';
  return null;
}

/** A text field: trimmed, within `max`; a NUL byte or a lone surrogate is `invalid_text` naming the field. */
export function readText(o: Raw, key: string, max: number, why: string[], required = true): string | null | undefined {
  const v = o[key];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (required) why.push(`${key} is required`);
    return required ? undefined : null;
  }
  if (typeof v !== 'string') { why.push(`${key} must be text`); return undefined; }
  const t = v.trim();
  const bad = invalidTextProblem(t);
  if (bad) { why.push(`${key} contains ${bad} (invalid_text)`); return undefined; }
  if (t.length > max) { why.push(`${key} is longer than ${max} characters`); return undefined; }
  return t;
}

export function readBool(o: Raw, key: string, why: string[]): boolean | undefined {
  const v = o[key];
  if (typeof v === 'boolean') return v;
  why.push(`${key} must be true or false`);
  return undefined;
}


/** A non-negative number. `cents: 'whole'` refuses a third decimal; `'round'` rounds half up to 2 dp (costs carry more). */
export function readNumber(
  o: Raw, key: string, why: string[], opts: { required?: boolean; cents?: 'whole' | 'round' | 'any'; positive?: boolean } = {},
): number | null | undefined {
  const v = o[key];
  const required = opts.required ?? false;
  if (v === undefined || v === null || v === '') {
    if (required) why.push(`${key} is required`);
    return required ? undefined : null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) { why.push(`${key} must be a number`); return undefined; }
  if (opts.positive ? v <= 0 : v < 0) { why.push(`${key} must be ${opts.positive ? 'more than 0' : 'not negative'}`); return undefined; }
  if (v > 1e11) { why.push(`${key} is larger than any amount a document holds`); return undefined; }
  if (opts.cents === 'whole' && !hasWholeCents(v)) { why.push(`${key} must be whole cents`); return undefined; }
  if (opts.cents === 'round') return Math.round(v * 100 + 1e-9) / 100;
  return v;
}

const SAST_OFFSET_MS = 2 * 3600 * 1000; // South Africa is UTC+2 all year (no daylight saving since 1944)
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * A Sage date or date-time as the South African calendar date. "2025-03-14" and a date-time with NO zone are taken as written;
 * one with a Z or an offset ("2026-03-04T22:00:00Z" is 2026-03-05 in Johannesburg) is converted to UTC+2 first. The date must be real.
 */
export function readDate(o: Raw, key: string, why: string[], required: boolean): string | null | undefined {
  const v = o[key];
  if (v === undefined || v === null || v === '') {
    if (required) why.push(`${key} is required`);
    return required ? undefined : null;
  }
  const m = typeof v === 'string' ? DATE_TIME.exec(v.trim()) : null;
  if (m) {
    const [, y, mo, d, time, zone] = m;
    const real = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (real.getUTCFullYear() === Number(y) && real.getUTCMonth() === Number(mo) - 1 && real.getUTCDate() === Number(d)) {
      if (!zone) return `${y}-${mo}-${d}`;
      const offset = zone === 'Z' ? 'Z' : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
      const at = Date.parse(`${y}-${mo}-${d}T${time}${offset}`);
      if (Number.isFinite(at)) return new Date(at + SAST_OFFSET_MS).toISOString().slice(0, 10);
    }
  }
  why.push(`${key} must be a real date (YYYY-MM-DD or an ISO date-time)`);
  return undefined;
}

