/**
 * Wave 6 EF review round 4 (the ledger breaker's D1, ported): the year to date counts final runs only, so an
 * approved run with NEITHER stamp was never read by a later month. Reopening it must not record its approval as
 * [-infinity, now) in approval_history (the gate would then believe November read October and pass a stale
 * November). A grandfathered run (approval_grandfathered_at, no approved_at) was final: its range stays unbounded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { judgeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDateGate';
import { reopenPayrollRun } from '@/modules/accounting/services/payroll/payrollRunReopen';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const D = crypto.randomUUID();
const USER = crypto.randomUUID();
let x = ''; const run: Record<string, string> = {};

async function seed(month: number, status: string, stamp: boolean | 'grandfathered', year = 2028): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, employee_count, total_gross, total_paye, total_net)
     VALUES ($1, $2, $3, 'calculated', 1, 30000, 5000, 25000) RETURNING id::text AS id`, [D, month, year])).rows[0]!.id;
  await pool.query(`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, net_pay)
     VALUES ($1, $2, 30000, 30000, 5000, 0, 0, 0, 25000)`, [id, x]);
  const set = stamp === 'grandfathered' ? ', approval_grandfathered_at = clock_timestamp()' : stamp ? ', approved_at = clock_timestamp()' : '';
  await pool.query(`UPDATE payroll_run_headers SET status = $2${set} WHERE id = $1`, [id, status]);
  return id;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [D, 'Breaker 1490 YTD']);
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [USER, `${USER}@rev1490.test`]);
  x = (await pool.query<{ id: string }>(`INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
     VALUES ($1, 'BR-Y', 'Br', 'Y', '2020-01-01') RETURNING id::text AS id`, [D])).rows[0]!.id;
  run.oct = await seed(10, 'approved', false);   // approved by status only (hand edit)
  run.nov = await seed(11, 'approved', true);    // calculated after October, approved
  // Migration 951's shape (final, no approved_at), in the previous tax year so it is outside October/November's.
  run.sep = await seed(9, 'approved', 'grandfathered', 2027);
}, 120_000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id = ANY($1::uuid[])', [Object.values(run)]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [D]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [D]);
    await pool.query('DELETE FROM audit_log WHERE user_id = $1', [USER]).catch(() => undefined);
    await pool.query('DELETE FROM companies WHERE id = $1', [D]);
  } finally { await pool.end(); }
});

describe('the YTD gate and an unstamped earlier month (wave 6 EF round 4)', () => {
  it('premise: November\'s cumulative PAYE left October out (final-only YTD)', async () => {
    const ytd = (await loadPayeYearToDate(D, run.nov!, { month: 11, year: 2028 } as never, [x])).get(x);
    expect(ytd?.tablePaye ?? 0).toBe(0);
  });
  it('S1 strand: November is not refused because of the unstamped October', async () => {
    expect((await judgeYearToDate(D, run.nov!)).blocker).toBeNull();
  });
  it('D1: October reopened and re-approved as it stands must be refused (November never counted it)', async () => {
    await reopenPayrollRun({ runId: run.oct!, companyId: D, userId: USER, reason: 'fix missing approval time' });
    const ranges = (await pool.query(`SELECT r FROM payroll_run_headers, unnest(approval_history) r WHERE id = $1`, [run.oct])).rows;
    expect(ranges).toEqual([]);  // was [-infinity, now): "approved since forever"
    expect((await judgeYearToDate(D, run.oct!)).blocker).not.toBeNull(); // November never counted October
  });
  it('a grandfathered run reopened keeps its approval unbounded below (it was final)', async () => {
    await reopenPayrollRun({ runId: run.sep!, companyId: D, userId: USER, reason: 'grandfathered reopen' });
    const h = (await pool.query(`SELECT lower_inf(r) AS unbounded FROM payroll_run_headers, unnest(approval_history) r WHERE id = $1`, [run.sep])).rows;
    expect(h).toEqual([{ unbounded: true }]);
  });
});
