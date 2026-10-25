/**
 * Fixtures for the migration 944 conversion tests (budgets-legacy-conversion*.int.test.ts): synthetic
 * companies in the shapes production and the registry produce, old-shape budget rows, and the
 * migration's own functions called in the order the migration calls them.
 */
import type { Pool } from 'pg';

export function legacyFixture(pool: Pool) {
  const co = crypto.randomUUID(), acct = crypto.randomUUID(), acct2 = crypto.randomUUID();
  const bare = crypto.randomUUID(), bareAcct = crypto.randomUUID(); // declares March, no periods at all
  const reg = crypto.randomUUID(), regAcct = crypto.randomUUID(); // periods made by the generator: registry-labelled
  const gap = crypto.randomUUID(), gapAcct = crypto.randomUUID(); // stored years with a hole between them
  const all = [co, bare, reg, gap];
  const JAN_DEC = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  const reset = async () => {
    await pool.query('DELETE FROM budget_month_amounts WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM accounting_budgets WHERE company_id = ANY($1)', [all]);
  };
  const cleanup = async () => {
    await reset();
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM fiscal_years WHERE company_id = ANY($1)', [all]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [all]);
  };

  /** Production's shape (co: March declared, periods labelled January-December 2026) and a company with no periods (bare). */
  async function setup() {
    if ((await pool.query('SELECT 1 FROM companies WHERE id = $1', [co])).rowCount) return;
    await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BUDCONV co', 3)`, [co]);
    await pool.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, $3, 'B-5000', 'Rent', 'expense', 'debit', 3, true), ($2, $3, 'B-6000', 'Wages', 'expense', 'debit', 3, true)`,
      [acct, acct2, co]);
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

  /** A company (reg or gap) with only the given stored years, optionally with their generated periods. */
  async function setupYears(company: string, account: string, years: ReadonlyArray<readonly [number, string, string, string?]>, periods = true) {
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM fiscal_years WHERE company_id = $1', [company]);
    await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BUDCONV years', 3) ON CONFLICT DO NOTHING`, [company]);
    await pool.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, $2, 'B-5000', 'Rent', 'expense', 'debit', 3, true) ON CONFLICT DO NOTHING`, [account, company]);
    for (const [label, start, end, kind] of years) {
      const y = (await pool.query(
        `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [company, label, start, end, kind ?? 'normal'])).rows[0];
      if (periods) await pool.query('SELECT public.fiscal_periods_generate($1)', [y.id]);
    }
  }
  /** A company whose periods the generator made after 940: FY2027 = March 2026 - February 2027, labelled 2027. */
  const setupRegistry = (window: readonly [string, string, number, string] = ['2026-03-01', '2027-02-28', 2027, 'normal']) =>
    setupYears(reg, regAcct, [[window[2], window[0], window[1], window[3]]]);

  const months = async (account: string, company = co) => (await pool.query(
    `SELECT to_char(month, 'YYYY-MM') m, amount::float a FROM budget_month_amounts WHERE company_id = $1 AND gl_account_id = $2 ORDER BY month`,
    [company, account])).rows.map((r) => [r.m, r.a]);
  const one = async (fn: string, company: string) => (await pool.query(`SELECT public.${fn}($1) AS n`, [company])).rows[0].n as number;
  const convert = (company = co) => one('budget_months_from_legacy', company);
  const mismatches = (company = co) => one('budget_months_legacy_mismatches', company);
  const follow = (company = co) => one('budget_headers_follow_months', company);
  /** The migration's own order: convert, verify, then move and copy the headers. */
  async function convertWithHeaders(company = co): Promise<number> {
    const converted = await convert(company);
    if ((await mismatches(company)) !== 0) throw new Error('the verification failed before the headers were moved');
    await follow(company);
    return converted;
  }
  const headers = async (account: string, company = co) => (await pool.query(
    `SELECT fiscal_year, budget_name, notes FROM accounting_budgets WHERE company_id = $1 AND gl_account_id = $2 ORDER BY fiscal_year`,
    [company, account])).rows as Array<{ fiscal_year: number; budget_name: string; notes: string | null }>;

  return {
    co, acct, acct2, bare, bareAcct, reg, regAcct, gap, gapAcct, all, JAN_DEC,
    reset, cleanup, setup, budget, setupYears, setupRegistry, months, convert, mismatches, follow, convertWithHeaders, headers,
  };
}
