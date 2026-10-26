/**
 * Decision 12 (budgets P1, migration 947): a change of financial year end, and its undo, carry the
 * PRIMARY budget's months into the year that now holds them, so no budget amount silently stops
 * counting (versions are keyed by year and the readers count only a version's own months). A
 * locked budget, or a scenario/reforecast holding months that would move, refuses the change up
 * front. Real PostgreSQL, through the services, with a fixed "today".
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { assessYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeService';
import { applyYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { undoYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeUndo';
import { upsertBudget } from '@/modules/accounting/services/core/budgetService';
import { loadWindowBudgets } from '@/modules/accounting/services/reports/budgetWindowService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const TODAY = '2026-10-23';
const user = crypto.randomUUID();
const made: string[] = [];
const OK = { reason: 'Align with the holding company year end', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true };

afterAll(async () => {
  try {
    for (const id of made) {
      await pool.query(
        `UPDATE budget_versions SET status = 'approved', unlocked_by = locked_by, unlocked_at = clock_timestamp(), unlock_reason = 'cleanup'
          WHERE company_id = $1 AND status = 'locked'`, [id]);
      for (const t of ['audit_log', 'budget_month_amounts', 'budget_versions', 'accounting_budgets', 'gl_accounts']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [id]);
      }
      await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_year_end_changes WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_years WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM companies WHERE id = $1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally { await pool.end(); }
}, 60000);

async function inTx<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, companyId, userId: user, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

/** A December year-end company (FY2026 = 2026, FY2027 = 2027) with rent budgeted 100 a month in 2026 and 10 in 2027. */
async function company() {
  if (made.length === 0) {
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
  }
  const id = crypto.randomUUID();
  made.push(id);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BV947 rehome', 1)`, [id]);
  const rent = (await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
     VALUES ($1, 'RH-5000', 'Rent', 'expense', 'debit', 3, true) RETURNING id`, [id])).rows[0].id as string;
  for (const d of ['2026-03-01', '2027-03-01']) await inTx(id, () => generateFiscalYearForDate(id, d));
  await inTx(id, () => upsertBudget(id, { glAccountId: rent, fiscalYear: 2026, annualAmount: 1200 }, user));
  await inTx(id, () => upsertBudget(id, { glAccountId: rent, fiscalYear: 2027, annualAmount: 120 }, user));
  return { id, rent };
}

const windowBudget = (c: { id: string; rent: string }, from: string, to: string) =>
  inTx(c.id, async () => (await loadWindowBudgets(c.id, from, to))[c.rent] ?? 0);
const stored = async (id: string) => Number((await pool.query(
  'SELECT COALESCE(SUM(amount), 0) s FROM budget_month_amounts WHERE company_id = $1', [id])).rows[0].s);

describe('P1: budget months follow a change of year end', () => {
  it('stretching FY2026 to February 2027 moves Jan-Feb 2027 into FY2026 and Mar 2027 on into FY2028; undo moves them back', async () => {
    const c = await company();
    expect(await windowBudget(c, '2026-01-01', '2027-02-28')).toBe(1220);
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, TODAY));
    // FY2026 is now January 2026 - February 2027 and FY2028 March 2027 - February 2028.
    expect(await windowBudget(c, '2026-01-01', '2027-02-28')).toBe(1220);
    expect(await windowBudget(c, '2027-03-01', '2028-02-29')).toBe(100);
    expect(await windowBudget(c, '2026-01-01', '2028-02-29')).toBe(1320);
    expect(await stored(c.id)).toBe(1320);
    const homes = (await pool.query(
      `SELECT v.fiscal_year, COUNT(*)::int n FROM budget_month_amounts bm JOIN budget_versions v ON v.id = bm.version_id
        WHERE bm.company_id = $1 GROUP BY 1 ORDER BY 1`, [c.id])).rows;
    expect(homes).toEqual([{ fiscal_year: 2026, n: 14 }, { fiscal_year: 2027, n: 0 }, { fiscal_year: 2028, n: 10 }].filter((h) => h.n > 0));

    await inTx(c.id, () => undoYearEndChange(c.id, user, 'Filed in error'));
    expect(await windowBudget(c, '2026-01-01', '2026-12-31')).toBe(1200);
    expect(await windowBudget(c, '2027-01-01', '2027-12-31')).toBe(120);
    expect(await stored(c.id)).toBe(1320);
  });

  it('a locked budget, or a scenario holding months that would move, refuses the change before anything is written', async () => {
    const c = await company();
    const fy2027 = (await pool.query(`SELECT id FROM budget_versions WHERE company_id = $1 AND fiscal_year = 2027 AND is_primary`, [c.id])).rows[0].id;
    await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [fy2027, user]);
    await pool.query(`UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = clock_timestamp() WHERE id = $1`, [fy2027, user]);
    const locked = await inTx(c.id, () => assessYearEndChange(c.id, { newYearEndMonth: 2 }, TODAY));
    expect(locked.refusals.join(' ')).toMatch(/Budgets would have to move between years with this change: .*FY2027 'Original' \(locked\)/);
    await expect(inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, TODAY))).rejects.toThrow(/Budgets would have to move/);
    expect((await pool.query('SELECT end_date::text e FROM fiscal_years WHERE company_id = $1 AND fiscal_year = 2026', [c.id])).rows[0].e).toBe('2026-12-31');

    await pool.query(
      `UPDATE budget_versions SET status = 'approved', unlocked_by = $2, unlocked_at = clock_timestamp(), unlock_reason = 'test' WHERE id = $1`, [fy2027, user]);
    const scen = (await pool.query(
      `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, created_by) VALUES ($1, 2027, 'Stretch', 'scenario', $2) RETURNING id`, [c.id, user])).rows[0].id;
    await pool.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount) VALUES ($1, $2, $3, '2027-01-01', 5)`, [c.id, scen, c.rent]);
    const scenario = await inTx(c.id, () => assessYearEndChange(c.id, { newYearEndMonth: 2 }, TODAY));
    expect(scenario.refusals.join(' ')).toMatch(/FY2027 'Stretch' \(not the primary budget, 1 month amount\(s\) moving\)/);
  });
});
