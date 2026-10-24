/**
 * Migration 944's conversion of old-shape budgets (accounting_budgets.period_amounts
 * keyed 'jan'..'dec', or legacy '0'..'11', or annual only) into per-month rows,
 * run through the migration's own function on real PostgreSQL. Every amount
 * lands in the calendar month the old reader showed, totals hold, and bad data
 * stops the conversion naming the row. All data synthetic.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getBudgets } from '@/modules/accounting/services/core/budgetService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const co = crypto.randomUUID(), acct = crypto.randomUUID(), acct2 = crypto.randomUUID();
const bare = crypto.randomUUID(), bareAcct = crypto.randomUUID(); // declares March, no periods at all
const reg = crypto.randomUUID(), regAcct = crypto.randomUUID(); // periods made by the generator: registry-labelled
const gap = crypto.randomUUID(), gapAcct = crypto.randomUUID(); // stored years FY2026 and FY2027 with a year-long hole between them
const all = [co, bare, reg, gap];

beforeEach(async () => {
  await pool.query('DELETE FROM budget_month_amounts WHERE company_id = ANY($1)', [all]);
  await pool.query('DELETE FROM accounting_budgets WHERE company_id = ANY($1)', [all]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM budget_month_amounts WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM accounting_budgets WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM fiscal_years WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [all]);
  } finally { await pool.end(); }
});

async function setup() {
  if ((await pool.query('SELECT 1 FROM companies WHERE id = $1', [co])).rowCount) return;
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BUDCONV co', 3)`, [co]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $3, 'B-5000', 'Rent', 'expense', 'debit', 3, true), ($2, $3, 'B-6000', 'Wages', 'expense', 'debit', 3, true)`,
    [acct, acct2, co]);
  // Production's shape: declares March, periods labelled January-December 2026.
  await pool.query(
    `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
     SELECT $1, TO_CHAR(MAKE_DATE(2026, m, 1), 'FMMonth YYYY'), m, 2026, MAKE_DATE(2026, m, 1),
            (MAKE_DATE(2026, m, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date
       FROM generate_series(1, 12) m`, [co]);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BUDCONV bare', 3)`, [bare]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $2, 'B-5000', 'Rent', 'expense', 'debit', 3, true)`, [bareAcct, bare]);
}
const budget = (account: string, fy: number, pa: unknown, annual = 0, company = co, notes: string | null = null) => pool.query(
  `INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, period_amounts, annual_amount, notes)
   VALUES ($1, 'old', $2, $3, $4::jsonb, $5, $6)`, [company, fy, account, JSON.stringify(pa), annual, notes]);

/** A company whose periods the generator made after 940: FY2027 = March 2026 - February 2027, labelled 2027. */
async function setupRegistry(window: [string, string, number, string] = ['2026-03-01', '2027-02-28', 2027, 'normal']) {
  await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [reg]);
  await pool.query('DELETE FROM fiscal_years WHERE company_id = $1', [reg]);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BUDCONV reg', 3) ON CONFLICT DO NOTHING`, [reg]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $2, 'B-5000', 'Rent', 'expense', 'debit', 3, true) ON CONFLICT DO NOTHING`, [regAcct, reg]);
  const [start, end, label, kind] = window;
  const y = (await pool.query(
    `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [reg, label, start, end, kind])).rows[0];
  await pool.query('SELECT public.fiscal_periods_generate($1)', [y.id]);
}
const JAN_DEC = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const months = async (account: string, company = co) => (await pool.query(
  `SELECT to_char(month, 'YYYY-MM') m, amount::float a FROM budget_month_amounts WHERE company_id = $1 AND gl_account_id = $2 ORDER BY month`,
  [company, account])).rows.map((r) => [r.m, r.a]);
const convert = async (company = co) => (await pool.query('SELECT public.budget_months_from_legacy($1) AS n', [company])).rows[0].n as number;
const mismatches = async (company = co) => (await pool.query('SELECT public.budget_months_legacy_mismatches($1) AS n', [company])).rows[0].n as number;

describe('944 conversion', () => {
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

  it('a month with more than two decimals is rounded to cents and still verifies', async () => {
    await setup();
    await budget(acct, 2026, { jan: 10.005, feb: 1.234, mar: '2.675' });
    expect(await convert()).toBe(3);
    expect(await months(acct)).toEqual([['2026-01', 10.01], ['2026-02', 1.23], ['2026-03', 2.68]]);
    expect(await mismatches()).toBe(0);
  });

  it('a budget regrouped under another registry year keeps its notes there: the header is copied to each label that holds converted months', async () => {
    await setup();
    // Periods are calendar-labelled, the registry's year is March-February: Jan-Feb 2026 are FY2026, Mar-Dec 2026 are FY2027.
    await budget(acct, 2026, JAN_DEC, 0, co, 'rent note');
    await convert();
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
    await convert();
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
    await convert();
    const headers = (await pool.query(
      `SELECT fiscal_year, notes FROM accounting_budgets WHERE company_id = $1 AND gl_account_id = $2 ORDER BY fiscal_year`, [co, acct])).rows;
    expect(headers).toEqual([{ fiscal_year: 2026, notes: 'note a' }, { fiscal_year: 2027, notes: 'note b' }]);
    expect(await mismatches()).toBe(0);
  });

  it('a registry that cannot place a month (no free label in a hole between stored years) does not stop the conversion', async () => {
    await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BUDCONV gap', 3) ON CONFLICT DO NOTHING`, [gap]);
    await pool.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, $2, 'B-5000', 'Rent', 'expense', 'debit', 3, true) ON CONFLICT DO NOTHING`, [gapAcct, gap]);
    await pool.query('DELETE FROM fiscal_years WHERE company_id = $1', [gap]);
    for (const [label, start, end] of [[2026, '2025-03-01', '2026-02-28'], [2027, '2027-03-01', '2028-02-29']] as const) {
      await pool.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date) VALUES ($1, $2, $3, $4)`, [gap, label, start, end]);
    }
    // The registry itself refuses a date in the hole ...
    await expect(pool.query(`SELECT * FROM public.fiscal_year_for_date($1, '2026-06-01')`, [gap])).rejects.toThrow(/no free label/);
    // ... but the conversion files the amounts by the old readers' placement and goes on.
    await budget(gapAcct, 2026, { mar: 1, jan: 2 }, 0, gap, 'kept');
    expect(await convert(gap)).toBe(2);
    expect(await months(gapAcct, gap)).toEqual([['2026-03', 1], ['2027-01', 2]]);
    expect(await mismatches(gap)).toBe(0);
  });

  it('with months in two registry years neither of which is its own, the notes are on both and none stays on the empty label', async () => {
    await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BUDCONV gap', 3) ON CONFLICT DO NOTHING`, [gap]);
    await pool.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, $2, 'B-5000', 'Rent', 'expense', 'debit', 3, true) ON CONFLICT DO NOTHING`, [gapAcct, gap]);
    await pool.query('DELETE FROM fiscal_years WHERE company_id = $1', [gap]);
    // Two short years labelled 2030 (Mar-Oct 2024) and 2031 (Nov 2024 - Feb 2025); the legacy label 2024 is neither.
    for (const [label, start, end] of [[2030, '2024-03-01', '2024-10-31'], [2031, '2024-11-01', '2025-02-28']] as const) {
      await pool.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date) VALUES ($1, $2, $3, $4)`, [gap, label, start, end]);
    }
    await budget(gapAcct, 2024, { jan: 1, mar: 3 }, 0, gap, 'both years');
    await convert(gap);
    const headers = (await pool.query(
      `SELECT fiscal_year, notes FROM accounting_budgets WHERE company_id = $1 AND gl_account_id = $2 ORDER BY fiscal_year`, [gap, gapAcct])).rows;
    expect(headers).toEqual([{ fiscal_year: 2030, notes: 'both years' }, { fiscal_year: 2031, notes: 'both years' }]);
  });
});
