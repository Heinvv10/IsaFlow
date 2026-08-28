/**
 * A DATE column must round-trip as the same calendar day it was stored on.
 *
 * Why: pg's default parser for DATE (OID 1082) builds a JS Date at LOCAL
 * midnight. Prod and dev run SAST (UTC+2), so `.toISOString()` on that value
 * converts to UTC first and lands on the PREVIOUS day — '2026-08-28'::date
 * read back as '2026-08-27'.
 *
 * That reached the ledger. bankRuleAutoPostLine and provisionalPostingService
 * both derived a journal's entry_date from bank_transactions.transaction_date
 * this way, so a transaction on the 1st of a month posted a journal dated the
 * last day of the PREVIOUS month — a different VAT period. bankRuleAutoPostLine
 * then ran its open-period check against that same shifted date.
 *
 * These tests pin the two halves of the fix:
 *   1. src/lib/neon.ts overrides the 1082 parser, so DATE arrives as a string.
 *   2. fmtDate() is correct for BOTH shapes, so call sites survive either way.
 *
 * The timezone is forced to Africa/Johannesburg rather than inherited: on a
 * UTC CI runner the bug is invisible and the test would pass while broken.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fmtDate } from '@/lib/neon';
import { isDbReachable } from '../helpers/dbReachable';

const ORIGINAL_TZ = process.env.TZ;

// UTC+2 with no DST — the offset that produced the production defect.
beforeAll(() => { process.env.TZ = 'Africa/Johannesburg'; });
afterAll(() => { process.env.TZ = ORIGINAL_TZ; });

describe('fmtDate — no UTC shift on either shape', () => {
  it('keeps the calendar day for a Date at local midnight', () => {
    // Exactly what pg's DEFAULT 1082 parser produced. fmtDate must not shift it.
    const localMidnight = new Date(2026, 7, 28, 0, 0, 0); // 2026-08-28 00:00 local
    expect(fmtDate(localMidnight)).toBe('2026-08-28');
    // The shape that was wrong, pinned so the contrast cannot be argued away.
    expect(localMidnight.toISOString().split('T')[0]).toBe('2026-08-27');
  });

  it('passes through a plain YYYY-MM-DD string unchanged', () => {
    // The shape the overridden parser now delivers.
    expect(fmtDate('2026-08-28')).toBe('2026-08-28');
  });

  it('truncates an ISO timestamp string without re-parsing it', () => {
    expect(fmtDate('2026-08-28T00:00:00.000Z')).toBe('2026-08-28');
  });

  it('returns empty string for null/undefined rather than throwing', () => {
    expect(fmtDate(null)).toBe('');
    expect(fmtDate(undefined)).toBe('');
  });

  it('holds on the first of the month — the VAT-period boundary case', () => {
    // A payment on 1 September belongs in the Sep-Oct VAT period. Shifted back
    // one day it lands in Jul-Aug, on a return that may already be filed.
    const firstOfMonth = new Date(2026, 8, 1, 0, 0, 0);
    expect(fmtDate(firstOfMonth)).toBe('2026-09-01');
    expect(firstOfMonth.toISOString().split('T')[0]).toBe('2026-08-31');
  });
});

describe('DATE column round-trip (DB-gated)', () => {
  it('reads back the stored calendar day, as a string', async () => {
    if (!(await isDbReachable())) return;
    const { sql } = await import('@/lib/neon');

    const rows = (await sql`
      SELECT '2026-08-28'::date AS d,
             '2026-09-01'::date AS first_of_month
    `) as Array<Record<string, unknown>>;

    const row = rows[0]!;

    // The parser override: a DATE has no time and no zone, so it stays a string.
    expect(typeof row.d).toBe('string');
    expect(row.d).toBe('2026-08-28');
    expect(row.first_of_month).toBe('2026-09-01');

    // And the accessor every call site uses agrees.
    expect(fmtDate(row.d)).toBe('2026-08-28');
    expect(fmtDate(row.first_of_month)).toBe('2026-09-01');
  });

  it('leaves TIMESTAMPTZ parsing alone — only 1082 is overridden', async () => {
    if (!(await isDbReachable())) return;
    const { sql } = await import('@/lib/neon');

    const rows = (await sql`
      SELECT '2026-08-28 12:00:00+02'::timestamptz AS ts
    `) as Array<Record<string, unknown>>;

    // A timestamptz IS a genuine instant — it must keep its Date parsing.
    expect(rows[0]!.ts).toBeInstanceOf(Date);
  });
});
