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
import { updateCompany } from '@/modules/accounting/services/core/companyService';
import { holdYearRegistry } from '@/modules/accounting/services/budgets/budgetVersionScope';
import { loadWindowBudgets } from '@/modules/accounting/services/reports/budgetWindowService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { backendPid, outcome, waitUntilBlocked } from './helpers/lockWait';
import { undoRefusals, latestLiveChange } from '@/modules/accounting/services/gl/financialYearEndChangeUndo';
import { assertFinancialYearStartChange, rebuildUnusedFiscalPeriods } from '@/modules/accounting/services/gl/fiscalYearStartChange';

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

  it('a budget save in flight when the change starts is waited for, and its months are re-homed with the rest', async () => {
    const c = await company();
    // FY2027 has no budget yet: the save creates its version, which the change cannot see or lock.
    await pool.query(`DELETE FROM budget_month_amounts WHERE company_id = $1 AND version_id IN
                        (SELECT id FROM budget_versions WHERE company_id = $1 AND fiscal_year = 2027)`, [c.id]);
    await pool.query('DELETE FROM budget_versions WHERE company_id = $1 AND fiscal_year = 2027', [c.id]);
    const t2 = await pool.connect(), t1 = await pool.connect();
    try {
      await t2.query('BEGIN');
      await als.run({ client: t2, companyId: c.id, userId: user, claims: {} } as never, () =>
        upsertBudget(c.id, { glAccountId: c.rent, fiscalYear: 2027, annualAmount: 2400 }, user));
      await t1.query('BEGIN');
      const pid = await backendPid(t1);
      const change = outcome(als.run({ client: t1, companyId: c.id, userId: user, claims: {} } as never, () =>
        applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, TODAY)).then(() => t1.query('COMMIT')));
      await waitUntilBlocked(pool, pid);
      await t2.query('COMMIT');
      expect(await change).toBe('ok');
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      await t2.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
    // Every stored amount is counted by the readers across the new years.
    expect(await stored(c.id)).toBe(1200 + 2400);
    expect(await windowBudget(c, '2026-01-01', '2028-02-29')).toBe(1200 + 2400);
  });

  it('a change whose months would clash in the target year is refused in the preview, not with a 500 on apply', async () => {
    const c = await company();
    const fy2026 = (await pool.query(`SELECT id FROM budget_versions WHERE company_id = $1 AND fiscal_year = 2026 AND is_primary`, [c.id])).rows[0].id;
    const cc = (await pool.query(`INSERT INTO cost_centres (company_id, code, name, cc_type) VALUES ($1, 'RH-C1', 'Branch', 'cc1') RETURNING id`, [c.id])).rows[0].id;
    // FY2026 budgets rent by CC1; FY2027 at company level: Jan-Feb 2027 cannot join FY2026.
    await pool.query('DELETE FROM budget_month_amounts WHERE version_id = $1', [fy2026]);
    await pool.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, cc1_id, month, amount) VALUES ($1, $2, $3, $4, '2026-06-01', 50)`,
      [c.id, fy2026, c.rent, cc]);
    const a = await inTx(c.id, () => assessYearEndChange(c.id, { newYearEndMonth: 2 }, TODAY));
    expect(a.refusals.join(' ')).toMatch(/budget RH-5000 at different levels/);
    await pool.query('DELETE FROM budget_month_amounts WHERE version_id = $1', [fy2026]);
    await pool.query('DELETE FROM cost_centres WHERE id = $1', [cc]);
  });

  it('the undo is refused up front when a budget it would move is locked', async () => {
    const c = await company();
    await inTx(c.id, () => applyYearEndChange(c.id, user, { newYearEndMonth: 2, ...OK }, TODAY));
    const fy2028 = (await pool.query(`SELECT id FROM budget_versions WHERE company_id = $1 AND fiscal_year = 2028 AND is_primary`, [c.id])).rows[0].id;
    await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [fy2028, user]);
    await pool.query(`UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = clock_timestamp() WHERE id = $1`, [fy2028, user]);
    const refusals = await inTx(c.id, async () => undoRefusals(c.id, await latestLiveChange(c.id)));
    expect(refusals.join(' ')).toMatch(/FY2028 'Original' \(locked\)/);
  });

  it("a company's first budget save racing a Settings start-month change waits for it and files under the new years", async () => {
    if (made.length === 0) {
      await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
    }
    const id = crypto.randomUUID();
    made.push(id);
    await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'BV947 start month', 1)`, [id]);
    const rent = (await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, 'RH-5000', 'Rent', 'expense', 'debit', 3, true) RETURNING id`, [id])).rows[0].id as string;
    for (const d of ['2026-03-01', '2027-03-01']) await inTx(id, () => generateFiscalYearForDate(id, d));
    const t1 = await pool.connect(), t2 = await pool.connect();
    try {
      // T1: the Settings change to a March start (companyService.updateCompany's order), held open.
      await t1.query('BEGIN');
      await als.run({ client: t1, companyId: id, userId: user, claims: {} } as never, async () => {
        expect(await assertFinancialYearStartChange(id, 3)).toBe(true);
        await t1.query('UPDATE companies SET financial_year_start = 3 WHERE id = $1', [id]);
        await rebuildUnusedFiscalPeriods(id, new Date(`${TODAY}T12:00:00`));
      });
      // T2: the first budget save, while T1 is open.
      await t2.query('BEGIN');
      const pid = await backendPid(t2);
      const save = outcome(als.run({ client: t2, companyId: id, userId: user, claims: {} } as never, () =>
        upsertBudget(id, { glAccountId: rent, fiscalYear: 2027, annualAmount: 1200 }, user)).then(() => t2.query('COMMIT')));
      await waitUntilBlocked(pool, pid);
      await t1.query('COMMIT');
      expect(await save).toBe('ok');
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      await t2.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
    expect(await stored(id)).toBe(1200);
    expect(await windowBudget({ id, rent }, '2025-01-01', '2029-12-31')).toBe(1200);
  });

  it('a Settings save (whole company, entity type unchanged) racing a budget save takes the locks in the same order: no deadlock, and the later one is refused', async () => {
    const id = crypto.randomUUID();
    made.push(id);
    await pool.query(`INSERT INTO companies (id, name, financial_year_start, entity_type) VALUES ($1, 'BV947 settings order', 1, 'pty_ltd')`, [id]);
    const rent = (await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, 'RH-5000', 'Rent', 'expense', 'debit', 3, true) RETURNING id`, [id])).rows[0].id as string;
    for (const d of ['2026-03-01', '2027-03-01']) await inTx(id, () => generateFiscalYearForDate(id, d));
    const t1 = await pool.connect(), t2 = await pool.connect();
    const ctx = (client: typeof t1) => ({ client, companyId: id, userId: user, claims: {} }) as never;
    try {
      // T2 is a budget save that has just taken the shared registry lock (its first step).
      await t2.query('BEGIN');
      await als.run(ctx(t2), () => holdYearRegistry(id));
      // T1: the Settings page sends the whole company, entity type included, with a new start month.
      await t1.query('BEGIN');
      const pid = await backendPid(t1);
      const settings = als.run(ctx(t1), () => updateCompany(id, { entityType: 'pty_ltd', financialYearStart: 3 }))
        .then(() => 'ok', (e: { code?: string; name?: string }) => e.code ?? e.name ?? 'error');
      await waitUntilBlocked(pool, pid);
      // T2 goes on to write: its FK check needs the companies row, which T1 must not be holding yet.
      const save = await outcome(als.run(ctx(t2), () => upsertBudget(id, { glAccountId: rent, fiscalYear: 2027, annualAmount: 1200 }, user)));
      expect(save).toBe('ok');
      await t2.query('COMMIT');
      // The save went first, so its budget now holds the years: Settings is refused readably, never a 40P01 deadlock.
      expect(await settings).toBe('FiscalPeriodsInUseError');
      await t1.query('ROLLBACK');
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      await t2.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
  });
});
