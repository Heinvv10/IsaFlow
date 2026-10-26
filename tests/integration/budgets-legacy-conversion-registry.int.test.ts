/**
 * Migration 944's conversion for a company whose periods the generator labelled by
 * registry year: each label is filed in its own window with no collision, a short
 * year's keys it never had are skipped, a hole between stored years does not stop
 * the conversion. Synthetic data, real PostgreSQL.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { legacyFixture } from './helpers/budgetLegacyFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const { reset, cleanup, reg, regAcct, gap, gapAcct, JAN_DEC, budget, setupYears, setupRegistry, months, convert, mismatches } = legacyFixture(pool);

beforeEach(reset);
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

describe('944 conversion: registry-labelled years', () => {
  it('a company whose periods the generator labelled by registry year files each label in its own window, with no collision', async () => {
    await setupRegistry();
    await budget(regAcct, 2026, JAN_DEC, 0, reg);
    await budget(regAcct, 2027, JAN_DEC, 0, reg);
    expect(await convert(reg)).toBe(24);
    // FY2027 finds its periods (Mar 2026 - Feb 2027); FY2026 has none and sits in the template year before (Mar 2025 - Feb 2026).
    const m = await months(regAcct, reg);
    expect(m).toHaveLength(24);
    expect(m.filter(([k]) => k >= '2026-03' && k <= '2027-02')).toEqual([
      ['2026-03', 3], ['2026-04', 4], ['2026-05', 5], ['2026-06', 6], ['2026-07', 7], ['2026-08', 8], ['2026-09', 9],
      ['2026-10', 10], ['2026-11', 11], ['2026-12', 12], ['2027-01', 1], ['2027-02', 2]]);
    expect(m.filter(([k]) => k < '2026-03')).toEqual([
      ['2025-03', 3], ['2025-04', 4], ['2025-05', 5], ['2025-06', 6], ['2025-07', 7], ['2025-08', 8], ['2025-09', 9],
      ['2025-10', 10], ['2025-11', 11], ['2025-12', 12], ['2026-01', 1], ['2026-02', 2]]);
    expect(await mismatches(reg)).toBe(0);
  });

  it('a label with two periods in one calendar month (a 14-month year) files the key under the earlier one', async () => {
    await setupRegistry(['2026-01-01', '2027-02-28', 2026, 'transition']);
    await budget(regAcct, 2026, { jan: 1, feb: 2, mar: 3 }, 0, reg);
    await convert(reg);
    expect(await months(regAcct, reg)).toEqual([['2026-01', 1], ['2026-02', 2], ['2026-03', 3]]);
  });

  it('a registry that cannot place a month (no free label in a hole between stored years) stops the conversion, naming the month', async () => {
    // FY2026 ends February 2026 and FY2027 starts March 2027: a year-long hole no label fits in.
    await setupYears(gap, gapAcct, [[2026, '2025-03-01', '2026-02-28'], [2027, '2027-03-01', '2028-02-29']], false);
    // The registry itself refuses a date in the hole ...
    await expect(pool.query(`SELECT * FROM public.fiscal_year_for_date($1, '2026-06-01')`, [gap])).rejects.toThrow(/no free label/);
    // ... and since migration 947 every amount belongs to the version of the registry year holding its month, so a
    // month no year holds cannot be filed: the conversion stops loudly (it filed it by the old placement under 944).
    await budget(gapAcct, 2026, { mar: 1, jan: 2 }, 0, gap, 'kept');
    await expect(convert(gap)).rejects.toThrow(/budget month 2027-01-01 of company .* has no financial year in the registry/);
    expect(await months(gapAcct, gap)).toEqual([]);
  });

  it('a short year\'s keys outside its window are skipped (the old reader never read them), so they do not collide with the next year', async () => {
    // FY2027 is a four-month year (a year-end change to June), then FY2028 is July 2026 - June 2027.
    await setupYears(reg, regAcct, [[2027, '2026-03-01', '2026-06-30', 'transition'], [2028, '2026-07-01', '2027-06-30']]);
    await budget(regAcct, 2027, JAN_DEC, 0, reg);
    await budget(regAcct, 2028, JAN_DEC, 0, reg);
    // FY2027 holds its four months; its other eight keys were never read by anything and are skipped.
    expect(await convert(reg)).toBe(4 + 12);
    expect((await months(regAcct, reg)).slice(0, 4)).toEqual([['2026-03', 3], ['2026-04', 4], ['2026-05', 5], ['2026-06', 6]]);
    expect((await months(regAcct, reg)).slice(4).map(([k]) => k)).toEqual(
      ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06']);
    expect((await pool.query('SELECT public.budget_months_legacy_skipped($1) AS n', [reg])).rows[0].n).toBe(8);
    expect(await mismatches(reg)).toBe(0);
  });
});
