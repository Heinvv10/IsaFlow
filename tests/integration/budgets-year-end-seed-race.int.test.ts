/**
 * A create-wizard seed racing a SHORTENING change of year end (PR-D review M1). The change (T1,
 * December -> November, held open) turns FY2027 from Jan-Dec 2027 into Dec 2026 - Nov 2027. The
 * seed (T2) copies a FY2025 scenario (twelve months, a version the change neither moves nor locks)
 * into a new FY2027 scenario, month by position. seedVersion holds the year registry FIRST, so it
 * waits for the change and then reads the NEW bounds: every month it writes lies inside the new
 * FY2027. Without that early hold it would read the old bounds and write December 2027, which the
 * shortened year no longer holds. Real PostgreSQL, through the services, with a fixed "today".
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { applyYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { seedVersion } from '@/modules/accounting/services/budgets/seedVersion';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { backendPid, outcome, waitUntilBlocked } from './helpers/lockWait';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const TODAY = '2026-10-23';
const user = crypto.randomUUID();
const id = crypto.randomUUID();
const OK = { reason: 'Align with the holding company year end', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true };
const ctx = (client: unknown) => ({ client, companyId: id, userId: user, claims: {} }) as never;

afterAll(async () => {
  try {
    for (const t of ['audit_log', 'budget_month_amounts', 'budget_versions', 'gl_accounts']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [id]);
    }
    await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [id]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
    await pool.query('DELETE FROM companies WHERE id = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally { await pool.end(); }
}, 60000);

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(ctx(client), fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

describe('a seed racing a shortening change of year end', () => {
  it('waits for the change and writes only months the shortened year holds', async () => {
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
    await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'PR-D seed race', 1)`, [id]);
    const rent = String((await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, 'SR-5000', 'Rent', 'expense', 'debit', 3, true) RETURNING id`, [id])).rows[0].id);
    for (const d of ['2025-03-01', '2026-03-01', '2027-03-01']) await inTx(() => generateFiscalYearForDate(id, d));
    const source = String((await pool.query(
      `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
       VALUES ($1, 2025, 'FY2025 scenario', 'scenario', false, $2) RETURNING id`, [id, user])).rows[0].id);
    await pool.query(`INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, created_by)
                      SELECT $1, $2, $3, make_date(2025, m, 1), 100 * m, $4 FROM generate_series(1, 12) m`, [id, source, rent, user]);

    const t1 = await pool.connect(), t2 = await pool.connect();
    let seeded: string | null = null;
    try {
      // T1: the year end moves from December to November (FY2026 ends 2026-11-30, so FY2027 becomes
      // 2026-12-01..2027-11-30), held open: it holds the year registry exclusively until it commits.
      await t1.query('BEGIN');
      await als.run(ctx(t1), () => applyYearEndChange(id, user, { newYearEndMonth: 11, ...OK }, TODAY));
      // T2: the wizard copies the FY2025 scenario into a new FY2027 scenario.
      await t2.query('BEGIN');
      const pid = await backendPid(t2);
      const seed = als.run(ctx(t2), () => seedVersion(id, { userId: user, role: 'owner' }, {
        fiscalYear: 2027, name: 'Racing seed', kind: 'scenario', makePrimary: false, roundingUnit: 1,
        source: { type: 'version', versionId: source, upliftPct: 0 },
      })).then((r) => { seeded = r.versionId; });
      const settled = outcome(seed.then(() => t2.query('COMMIT')));
      // The seed must wait for the change; if it does not, it finishes first and its months show it.
      await Promise.race([waitUntilBlocked(pool, pid), settled]);
      await t1.query('COMMIT');
      expect(await settled).toBe('ok');
    } finally {
      await t1.query('ROLLBACK').catch(() => undefined);
      await t2.query('ROLLBACK').catch(() => undefined);
      t1.release();
      t2.release();
    }
    const fy = (await pool.query(`SELECT start_date::text s, end_date::text e FROM fiscal_years WHERE company_id = $1 AND fiscal_year = 2027`, [id])).rows[0];
    expect([fy.s, fy.e]).toEqual(['2026-12-01', '2027-11-30']);
    const months = (await pool.query(
      `SELECT to_char(month, 'YYYY-MM') m, amount::text a FROM budget_month_amounts WHERE version_id = $1 ORDER BY month`, [seeded])).rows;
    // Twelve months by position, Dec 2026 - Nov 2027: none outside the shortened year.
    expect(months.map((r) => r.m)).toEqual(['2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06',
      '2027-07', '2027-08', '2027-09', '2027-10', '2027-11']);
    expect(months.map((r) => Number(r.a))).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]);
  });
});
