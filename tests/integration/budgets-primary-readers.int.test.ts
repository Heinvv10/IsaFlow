/**
 * Budgets P1 (migration 947), readers on the PRIMARY version: the budgets page reader
 * (getBudgetsForYear), the window reader under Budget vs Actual, its export, the comparator, MCP and
 * packs (loadWindowBudgets) and getBudgetVariance show, after the conversion, exactly the figures
 * the legacy rows summed to before it. A draft reforecast with other amounts changes none of them,
 * and is what a named versionId reads. A window across two financial years takes each year's
 * primary; a primary's row for a month outside its own year is not counted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { getBudgetsForYear } from '@/modules/accounting/services/core/budgetService';
import { loadWindowBudgets } from '@/modules/accounting/services/reports/budgetWindowService';
import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';
import { requireFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const co = crypto.randomUUID(), rent = crypto.randomUUID(), sales = crypto.randomUUID(), user = crypto.randomUUID();

beforeAll(async () => {
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BV947 readers', 3)`, [co]);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, $3, 'PR-5000', 'Rent', 'expense', 'debit', 3, true), ($2, $3, 'PR-4000', 'Sales', 'revenue', 'credit', 3, true)`,
    [rent, sales, co]);
  // FY2027 = March 2026 - February 2027; FY2028 = March 2027 - February 2028.
  await pool.query(
    `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
     VALUES ($1, 2027, '2026-03-01', '2027-02-28', 'normal'), ($1, 2028, '2027-03-01', '2028-02-29', 'normal')`, [co]);
});
afterAll(async () => {
  try {
    for (const t of ['audit_log', 'budget_month_amounts', 'budget_versions', 'accounting_budgets', 'gl_accounts', 'fiscal_periods', 'fiscal_years']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [co]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [co]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally {
    await pool.end();
  }
});

interface Figures { page2027: Array<[string, number]>; window2027: Record<string, number>; across: Record<string, number>; variance: [number, number] }

/** The three readers, on the transaction's own connection (as withAuth binds it). */
async function read(c: PoolClient, versionId?: string): Promise<Figures> {
  return als.run({ client: c, companyId: co, userId: user, claims: {} } as never, async () => {
    const fy2027 = await requireFiscalYear(co, 2027);
    const page = await getBudgetsForYear(co, fy2027, versionId);
    const window2027 = await loadWindowBudgets(co, '2026-03-01', '2027-02-28', versionId);
    const across = await loadWindowBudgets(co, '2026-09-01', '2027-08-31');
    const v = await getBudgetVariance(co, '2026-03-01', '2027-02-28');
    return {
      page2027: page.map((e) => [e.accountCode, e.annualAmount] as [string, number]),
      window2027: { rent: window2027[rent] ?? 0, sales: window2027[sales] ?? 0 },
      across: { rent: across[rent] ?? 0, sales: across[sales] ?? 0 },
      variance: [v.totals.budget, v.rows.length],
    };
  });
}

/** Legacy-shaped rows (no version), golden sums by plain SQL, then 947's conversion; rolled back. */
async function converted(fn: (c: PoolClient, golden: Figures) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE budget_month_amounts ALTER COLUMN version_id DROP NOT NULL');
    // Rent 100 a month for 24 months (both years); sales 50 a month through FY2027 only.
    await c.query(
      `INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount)
       SELECT $1, $2, (DATE '2026-03-01' + make_interval(months => g))::date, 100 FROM generate_series(0, 23) g`, [co, rent]);
    await c.query(
      `INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount)
       SELECT $1, $2, (DATE '2026-03-01' + make_interval(months => g))::date, 50 FROM generate_series(0, 11) g`, [co, sales]);
    const sum = async (acct: string, from: string, to: string) => Number((await c.query(
      `SELECT COALESCE(SUM(amount), 0) s FROM budget_month_amounts WHERE company_id = $1 AND gl_account_id = $2 AND month BETWEEN $3 AND $4`,
      [co, acct, from, to])).rows[0].s);
    const golden: Figures = {
      page2027: [['PR-4000', await sum(sales, '2026-03-01', '2027-02-01')], ['PR-5000', await sum(rent, '2026-03-01', '2027-02-01')]],
      window2027: { rent: await sum(rent, '2026-03-01', '2027-02-01'), sales: await sum(sales, '2026-03-01', '2027-02-01') },
      across: { rent: await sum(rent, '2026-09-01', '2027-08-01'), sales: await sum(sales, '2026-09-01', '2027-08-01') },
      variance: [await sum(rent, '2026-03-01', '2027-02-01') + await sum(sales, '2026-03-01', '2027-02-01'), 2],
    };
    await c.query('SELECT public.budget_versions_from_months($1)', [co]);
    await c.query('ALTER TABLE budget_month_amounts ALTER COLUMN version_id SET NOT NULL');
    await fn(c, golden);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('P1: readers use the primary version', () => {
  it('after the conversion every reader shows the figures the legacy rows summed to', async () => {
    await converted(async (c, golden) => {
      expect(golden.window2027).toEqual({ rent: 1200, sales: 600 });
      expect(golden.across).toEqual({ rent: 1200, sales: 300 });
      expect(await read(c)).toEqual(golden);
    });
  });

  it('a draft reforecast with other amounts changes nothing; a named versionId reads the draft', async () => {
    await converted(async (c, golden) => {
      const draft = (await c.query(
        `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, created_by) VALUES ($1, 2027, 'Q1 reforecast', 'reforecast', $2) RETURNING id`,
        [co, user])).rows[0].id;
      await c.query(
        `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount)
         SELECT $1, $2, $3, (DATE '2026-03-01' + make_interval(months => g))::date, 7 FROM generate_series(0, 11) g`, [co, draft, rent]);
      expect(await read(c)).toEqual(golden);
      const named = await read(c, draft);
      expect(named.page2027).toEqual([['PR-5000', 84]]);
      expect(named.window2027).toEqual({ rent: 84, sales: 0 });
    });
  });

  it("a primary's row for a month outside its own year is not counted by any reader", async () => {
    await converted(async (c, golden) => {
      const fy2027 = (await c.query(`SELECT id FROM budget_versions WHERE company_id = $1 AND fiscal_year = 2027 AND is_primary`, [co])).rows[0].id;
      // June 2027 is FY2028's; a stray FY2027 row for it must not double FY2028's June in a window across both years.
      await c.query(
        `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount) VALUES ($1, $2, $3, '2027-06-01', 9999)`,
        [co, fy2027, sales]);
      expect(await read(c)).toEqual(golden);
    });
  });
});
