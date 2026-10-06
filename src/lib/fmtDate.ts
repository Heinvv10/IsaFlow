/**
 * Format a value from a DB date column as YYYY-MM-DD.
 *
 * WHY THIS IS NOT IN neon.ts: it used to be, and that made every
 * `vi.mock('@/lib/neon', ...)` in the test suite silently delete it — 173 test
 * files mock that module, so any service that newly imported fmtDate broke its
 * own tests with "No fmtDate export is defined on the @/lib/neon mock". The
 * function touches no connection, no pool and no query; it has no business
 * living behind the DB module. neon.ts re-exports it so existing
 * `import { fmtDate } from '@/lib/neon'` call sites keep working.
 *
 * Robust to both shapes a date column can arrive in:
 *
 *   - a plain 'YYYY-MM-DD' string — what src/lib/pgTypes.ts now makes pg
 *     return for DATE (OID 1082), and the honest representation of a value
 *     that carries no time and no zone;
 *   - a JS Date — what pg's DEFAULT parser returned (at LOCAL midnight), and
 *     what a caller passes when formatting a locally-computed date.
 *
 * Uses LOCAL calendar getters, never toISOString(). On this UTC+2 host
 * toISOString() converts to UTC first and reports the PREVIOUS day: a Date at
 * 2026-08-28 00:00 SAST serialises as '2026-08-27'. That shifted journal entry
 * dates across VAT-period boundaries — see src/lib/pgTypes.ts for the full
 * account.
 */
export function fmtDate(val: unknown): string {
  if (!val) return '';
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val);
  if (s.includes('T')) return s.split('T')[0]!;
  return s;
}
