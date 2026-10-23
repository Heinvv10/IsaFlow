/**
 * Migration 944's conversion of old-shape budgets (accounting_budgets.period_amounts
 * keyed 'jan'..'dec', or legacy '0'..'11', or annual only) into per-month rows,
 * run through the migration's own function on real PostgreSQL. Every amount
 * lands in the calendar month the old reader showed, totals hold, and bad data
 * stops the conversion naming the row. All data synthetic.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const co = crypto.randomUUID(), acct = crypto.randomUUID(), acct2 = crypto.randomUUID();
const bare = crypto.randomUUID(), bareAcct = crypto.randomUUID(); // declares March, no periods at all

beforeEach(async () => {
  await pool.query('DELETE FROM budget_month_amounts WHERE company_id = ANY($1)', [[co, bare]]);
  await pool.query('DELETE FROM accounting_budgets WHERE company_id = ANY($1)', [[co, bare]]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM budget_month_amounts WHERE company_id = ANY($1)', [[co, bare]]);
    await pool.query('DELETE FROM accounting_budgets WHERE company_id = ANY($1)', [[co, bare]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [[co, bare]]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[co, bare]]);
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
const budget = (account: string, fy: number, pa: unknown, annual = 0, company = co) => pool.query(
  `INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, period_amounts, annual_amount)
   VALUES ($1, 'old', $2, $3, $4::jsonb, $5)`, [company, fy, account, JSON.stringify(pa), annual]);
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
});
