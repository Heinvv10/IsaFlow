/**
 * Migration 944's notes headers follow the converted months into the registry years that hold
 * them (budget_headers_follow_months, run AFTER the verification): copied to every label that
 * holds months, MOVED when none of the months is under the header's own label, in the order
 * that lets one row move into the label another has just left. Synthetic data, real PostgreSQL.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { getBudgets } from '@/modules/accounting/services/core/budgetService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { legacyFixture } from './helpers/budgetLegacyFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const { reset, cleanup, co, acct, bare, bareAcct, gap, gapAcct, JAN_DEC, setup, budget, setupYears, months, convert, mismatches, follow, convertWithHeaders, headers } = legacyFixture(pool);

beforeEach(reset);
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

describe('944 conversion: notes headers', () => {
  it('a budget regrouped under another registry year keeps its notes there: the header is copied to each label that holds converted months', async () => {
    await setup();
    // Periods are calendar-labelled, the registry's year is March-February: Jan-Feb 2026 are FY2026, Mar-Dec 2026 are FY2027.
    await budget(acct, 2026, JAN_DEC, 0, co, 'rent note');
    await convertWithHeaders();
    const fy2026 = await getBudgets(co, 2026);
    const fy2027 = await getBudgets(co, 2027);
    expect(fy2026.map((e) => [e.notes, e.annualAmount])).toEqual([['rent note', 3]]);
    expect(fy2027.map((e) => [e.notes, e.annualAmount])).toEqual([['rent note', 75]]);
    const headers = (await pool.query(
      `SELECT fiscal_year, budget_name FROM accounting_budgets WHERE company_id = $1 AND gl_account_id = $2 ORDER BY fiscal_year`, [co, acct])).rows;
    expect(headers).toEqual([{ fiscal_year: 2026, budget_name: 'old' }, { fiscal_year: 2027, budget_name: 'FY2027 Budget' }]);
  });

  it('a header none of whose months land under its label MOVES to a registry label that holds them', async () => {
    await setup();
    // March-April 2026 are registry FY2027, so the FY2026 header (and its note) would sit on an empty year.
    await budget(acct, 2026, { mar: 3, apr: 4 }, 0, co, 'moved note');
    await convertWithHeaders();
    const headers = (await pool.query(
      `SELECT fiscal_year, budget_name, notes FROM accounting_budgets WHERE company_id = $1 AND gl_account_id = $2 ORDER BY fiscal_year`, [co, acct])).rows;
    expect(headers).toEqual([{ fiscal_year: 2027, budget_name: 'FY2027 Budget', notes: 'moved note' }]);
    expect(await getBudgets(co, 2026)).toEqual([]);
    expect((await getBudgets(co, 2027)).map((e) => [e.notes, e.annualAmount])).toEqual([['moved note', 7]]);
  });

  it('a header whose first label already has one stays where it is (the copy does nothing)', async () => {
    await setup();
    await budget(acct, 2026, { mar: 3 }, 0, co, 'note a');   // March 2026 is FY2027
    await budget(acct, 2027, { jan: 5 }, 0, co, 'note b');   // January 2027 is FY2027 too
    await convertWithHeaders();
    const headers = (await pool.query(
      `SELECT fiscal_year, notes FROM accounting_budgets WHERE company_id = $1 AND gl_account_id = $2 ORDER BY fiscal_year`, [co, acct])).rows;
    expect(headers).toEqual([{ fiscal_year: 2026, notes: 'note a' }, { fiscal_year: 2027, notes: 'note b' }]);
    expect(await mismatches()).toBe(0);
  });

  it('with months in two registry years neither of which is its own, the notes are on both and none stays on the empty label', async () => {
    // Two short years labelled 2030 (Mar-Oct 2024) and 2031 (Nov 2024 - Feb 2025); the legacy label 2024 is neither.
    await setupYears(gap, gapAcct, [[2030, '2024-03-01', '2024-10-31'], [2031, '2024-11-01', '2025-02-28']], false);
    await budget(gapAcct, 2024, { jan: 1, mar: 3 }, 0, gap, 'both years');
    await convertWithHeaders(gap);
    expect(await headers(gapAcct, gap)).toEqual([
      { fiscal_year: 2030, budget_name: 'FY2030 Budget', notes: 'both years' }, { fiscal_year: 2031, budget_name: 'FY2031 Budget', notes: 'both years' }]);
  });

  it('a header moves into the label the next row has just left: FY2026 and its copy FY2027 each end up under the year their months are in', async () => {
    // A company with no periods (Dotbiz): FY2026 is Mar 2026 - Feb 2027 = registry FY2027, FY2027 is registry FY2028.
    await budget(bareAcct, 2026, JAN_DEC, 0, bare, 'notes-FY2026');
    await budget(bareAcct, 2027, JAN_DEC, 0, bare, 'notes-FY2027');
    await convertWithHeaders(bare);
    expect((await headers(bareAcct, bare)).map((h) => [h.fiscal_year, h.notes])).toEqual([[2027, 'notes-FY2026'], [2028, 'notes-FY2027']]);
    expect((await getBudgets(bare, 2027)).map((e) => [e.notes, e.annualAmount])).toEqual([['notes-FY2026', 78]]);
    expect((await getBudgets(bare, 2028)).map((e) => [e.notes, e.annualAmount])).toEqual([['notes-FY2027', 78]]);
  });

  it('the verification runs before the headers move: totals still foot per row at that point, and the headers step is separate', async () => {
    await setup();
    await budget(acct, 2026, { mar: 3, apr: 4 }, 0, co, 'moved note');
    expect(await convert()).toBe(2);
    // Before the headers step the legacy row is still under its own label and the verification is clean.
    expect(await mismatches()).toBe(0);
    expect((await headers(acct)).map((h) => h.fiscal_year)).toEqual([2026]);
    expect(await follow()).toBeGreaterThan(0);
    expect((await headers(acct)).map((h) => h.fiscal_year)).toEqual([2027]);
  });

  it('a label the registry refuses (a typo far from every stored year) leaves its notes in place and the headers step completes', async () => {
    // Stored years in 2026-2028 and a budget label in the year 3000: 500+ steps from any stored year. Only notes
    // depend on the headers step (the months are filed and verified), so a registry refusal must not stop it.
    await setupYears(gap, gapAcct, [[2027, '2026-03-01', '2027-02-28'], [2028, '2027-03-01', '2028-02-29']], false);
    await budget(gapAcct, 3000, { mar: 1 }, 0, gap, 'far');
    // Since migration 947 the month itself cannot be filed (no registry year holds it, so no version does):
    // the conversion stops loudly. The headers step reads the legacy rows, not the months, and still completes.
    await expect(convert(gap)).rejects.toThrow(/budget month 3000-03-01 of company .* has no financial year in the registry/);
    await follow(gap);
    expect((await headers(gapAcct, gap)).map((h) => h.fiscal_year)).toEqual([3000]);
  });

  it('the migration itself verifies first and moves the headers after: its DO block, run on legacy rows, succeeds and files the headers', async () => {
    // The DO block of 944 as shipped (extracted from the file), run on rows only this test made, then rolled back.
    const sqlText = readFileSync(new URL('../../scripts/migrations/sql/944_budget_month_amounts.sql', import.meta.url), 'utf8');
    const block = /\nDO \$\$[\s\S]*?\n\$\$;/.exec(sqlText)?.[0];
    expect(block, 'the DO block of migration 944').toBeTruthy();
    await budget(bareAcct, 2026, JAN_DEC, 0, bare, 'notes-FY2026');
    await budget(bareAcct, 2027, JAN_DEC, 0, bare, 'notes-FY2027');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL client_min_messages = warning`);
      // Other suites' leftovers are not this test's business: only this company's rows may be legacy.
      await client.query(`DELETE FROM accounting_budgets WHERE company_id <> $1 AND period_amounts <> '{}'::jsonb`, [bare]);
      await client.query(block!);
      const filed = (await client.query(
        `SELECT fiscal_year, notes FROM accounting_budgets WHERE company_id = $1 ORDER BY fiscal_year`, [bare])).rows;
      expect(filed).toEqual([{ fiscal_year: 2027, notes: 'notes-FY2026' }, { fiscal_year: 2028, notes: 'notes-FY2027' }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
