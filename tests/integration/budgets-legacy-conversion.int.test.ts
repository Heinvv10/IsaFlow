/**
 * Migration 944's conversion of old-shape budgets (accounting_budgets.period_amounts
 * keyed 'jan'..'dec', or legacy '0'..'11', or annual only) into per-month rows,
 * run through the migration's own function on real PostgreSQL. Every amount
 * lands in the calendar month the old reader showed, totals hold, and bad data
 * stops the conversion naming the row. Registry-labelled companies and short
 * years are in budgets-legacy-conversion-registry.int.test.ts, the notes
 * headers in budgets-legacy-headers.int.test.ts. All data synthetic.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { legacyFixture } from './helpers/budgetLegacyFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const { reset, cleanup, co, acct, acct2, bare, bareAcct, setup, budget, months, convert, mismatches } = legacyFixture(pool);

beforeEach(reset);
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

describe('944 conversion: months', () => {
  it('named month keys land in the calendar months of the label\'s periods, zero months kept', async () => {
    await setup();
    await budget(acct, 2026, { jan: 100, feb: 0, mar: 300, dec: 1200.55 });
    expect(await convert()).toBe(4);
    expect(await months(acct)).toEqual([['2026-01', 100], ['2026-02', 0], ['2026-03', 300], ['2026-12', 1200.55]]);
    expect(await mismatches()).toBe(0);
  });

  it('legacy numeric keys 0..11 are January..December', async () => {
    await setup();
    await budget(acct, 2026, { 0: 10, 11: 20 });
    await convert();
    expect(await months(acct)).toEqual([['2026-01', 10], ['2026-12', 20]]);
  });

  it('an annual-only row is spread over twelve months, cents on December', async () => {
    await setup();
    await budget(acct, 2026, {}, 1000);
    await convert();
    const m = await months(acct);
    expect(m).toHaveLength(12);
    expect(m[0]).toEqual(['2026-01', 83.33]);
    expect(m[11]).toEqual(['2026-12', 83.37]);
    expect(await mismatches()).toBe(0);
  });

  it('a label with no periods uses that calendar year', async () => {
    await setup();
    await budget(acct2, 2027, { jan: 5, mar: 7 });
    await convert();
    expect(await months(acct2)).toEqual([['2027-01', 5], ['2027-03', 7]]);
  });

  it('two labels of one account keep their months apart', async () => {
    await setup();
    await budget(acct, 2026, { dec: 1 });
    await budget(acct, 2027, { jan: 2 });
    await convert();
    expect(await months(acct)).toEqual([['2026-12', 1], ['2027-01', 2]]);
    expect(await mismatches()).toBe(0);
  });

  it('a value that is not a number stops the conversion and names the row', async () => {
    await setup();
    await budget(acct, 2026, { jan: 'abc' });
    await expect(convert()).rejects.toThrow(/month jan is not a number/);
  });

  it('a period_amounts that is not an object stops the conversion', async () => {
    await setup();
    await budget(acct, 2026, [1, 2, 3]);
    await expect(convert()).rejects.toThrow(/not an object/);
  });

  it('a company with no periods at all reads its label as the declared-month window: a March company\'s FY2026 jan is January 2027', async () => {
    await setup();
    await budget(bareAcct, 2026, { jan: 1, feb: 2, mar: 3, dec: 12 }, 0, bare);
    await convert(bare);
    expect(await months(bareAcct, bare)).toEqual([['2026-03', 3], ['2026-12', 12], ['2027-01', 1], ['2027-02', 2]]);
    expect(await mismatches(bare)).toBe(0);
  });

  it('a month name shadows a stale numeric key for the same month, as the reader read it', async () => {
    await setup();
    await budget(acct, 2026, { jan: 100, 0: 50 });
    expect(await convert()).toBe(1);
    expect(await months(acct)).toEqual([['2026-01', 100]]);
    expect(await mismatches()).toBe(0);
  });

  it('an empty string is 0, as the reader\'s Number(\'\') was', async () => {
    await setup();
    await budget(acct, 2026, { jan: 100, feb: '' });
    await convert();
    expect(await months(acct)).toEqual([['2026-01', 100], ['2026-02', 0]]);
    expect(await mismatches()).toBe(0);
  });

  it('a row naming another company\'s account (never shown by any reader) is not converted and does not fail verification', async () => {
    await setup();
    await budget(bareAcct, 2026, { jan: 9 });
    expect(await convert()).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int n FROM budget_month_amounts WHERE company_id = $1', [co])).rows[0].n).toBe(0);
    expect(await mismatches()).toBe(0);
  });

  it('the verification sees an amount that went missing', async () => {
    await setup();
    await budget(acct, 2026, { jan: 100, feb: 50 });
    await convert();
    await pool.query(`DELETE FROM budget_month_amounts WHERE company_id = $1 AND month = '2026-02-01'`, [co]);
    expect(await mismatches()).toBe(1);
  });

  it('a month with more than two decimals is rounded to cents and still verifies', async () => {
    await setup();
    await budget(acct, 2026, { jan: 10.005, feb: 1.234, mar: '2.675' });
    expect(await convert()).toBe(3);
    expect(await months(acct)).toEqual([['2026-01', 10.01], ['2026-02', 1.23], ['2026-03', 2.68]]);
    expect(await mismatches()).toBe(0);
  });
});
