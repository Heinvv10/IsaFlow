/**
 * Wave 6 FQd, merge review #1622 L1: the EMP501 reconciliation's PSP split (PSP, payroll-detail roles) on the interim
 * (?period=interim, March to August) counts the interim's months only. A PSP company is paid in April and again in
 * September: the interim's totalPspPaye is April's alone and its runWarnings are over the interim's PSP totals; the
 * annual counts both months.
 *
 * Disposable DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { addEmployee, newRun } from './ts-b.helpers';
import type { Route } from './w3-01-payroll.helpers';
import reconciliationRoute from '../../pages/api/payroll/emp501/reconciliation';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { formatMoney } from '@/lib/money/formatMoney';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
const approve = (run: string) => pool.query(`UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1`, [run]);
type Recon = { rows: Array<{ month: number; pspPaye?: number }>; totalPspPaye?: number; runWarnings: string[] };

let f: SeveranceFixture;
let aprilPsp = 0;
let septemberPsp = 0;
const recon = async (period?: 'interim') => {
  const query = { taxYear: '2027', ...(period ? { period } : {}) };
  const out = await f.call(reconciliationRoute as Route, 'GET', `/api/payroll/emp501/reconciliation?taxYear=2027${period ? '&period=interim' : ''}`, undefined, { query });
  expect(out.statusCode).toBe(200);
  return (out.body as unknown as { data: Recon }).data;
};
const pspOf = async (run: string, who: string) => Number((await pool.query(
  'SELECT paye::float8 AS paye FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [run, who])).rows[0]!.paye);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T12:00:00+02:00'));
  f = await seedEmployee(pool, fixtures, 'fqd psp interim', 30_000);
  const who = await addEmployee(pool, f, 'fqd-psp', 40_000);
  await updatePayrollEmployee(who, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
  const april = await newRun(pool, f, 4);
  await calculatePayrollRun(april, f.company);
  await approve(april);
  const september = await newRun(pool, f, 9);
  await calculatePayrollRun(september, f.company);
  await approve(september);
  aprilPsp = await pspOf(april, who);
  septemberPsp = await pspOf(september, who);
}, 240_000);
afterAll(async () => {
  vi.useRealTimers();
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

describe('the interim reconciliation\'s PSP split stays inside March to August', () => {
  it('both months carry PSP PAYE (27% of R40 000)', () => {
    expect([aprilPsp, septemberPsp]).toEqual([10_800, 10_800]);
  });

  it('the annual: totalPspPaye is April and September', async () => {
    const annual = await recon();
    expect(annual.totalPspPaye).toBe(21_600);
    expect(annual.rows.find((r) => r.month === 9)?.pspPaye).toBe(10_800);
  });

  it('the interim: totalPspPaye is April alone, no September row, and its PSP warning carries April\'s figure only', async () => {
    const interim = await recon('interim');
    expect(interim.totalPspPaye).toBe(10_800);
    expect(interim.rows.map((r) => r.month)).toEqual([3, 4, 5, 6, 7, 8]);
    const psp = interim.runWarnings.filter((w) => w.includes('TSB-fqd-psp'));
    expect(psp).toHaveLength(1);
    expect(psp[0]).toContain(`PAYE ${formatMoney(10_800)}`);
    expect((await recon()).runWarnings.find((w) => w.includes('TSB-fqd-psp'))).toContain(`PAYE ${formatMoney(21_600)}`);
  });
});
