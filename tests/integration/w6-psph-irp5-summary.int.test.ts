/**
 * Wave 6 PSP-H: the IRP5 summary's IRP5_PSP_NOT_CERTIFIED warning (pages/api/payroll/irp5/summary.ts), pinned (DBF merge
 * review L). A person paid as a PSP in March and as an employee in April: the natural person's certificate leaves March out,
 * and the warning says where March is. Without the entity's particulars it is on no certificate (add them); with them it is
 * on the entity's own H certificate in the e@syFile file. Disposable DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { addEmployee, newRun } from './ts-b.helpers';
import type { Route } from './w3-01-payroll.helpers';
import summary from '../../pages/api/payroll/irp5/summary';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
const approve = (run: string) => pool.query(`UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1`, [run]);

type Msg = { code: string; message: string };
async function pspMessages(f: SeveranceFixture, who: string): Promise<Msg[]> {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
  req.url = '/api/payroll/irp5/summary?taxYear=2027';
  req.query = { taxYear: '2027' };
  const out = response();
  await (summary as Route)(req as never, out.res as never);
  expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
  const emp = (out.state.body as { data: { employees: Array<{ employeeId: string; messages: Msg[] }> } }).data.employees.find((e) => e.employeeId === who);
  return (emp?.messages ?? []).filter((m) => m.code === 'IRP5_PSP_NOT_CERTIFIED');
}

let f: SeveranceFixture;
let who = '';
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-15T12:00:00+02:00'));
  f = await seedEmployee(pool, fixtures, 'psph summary', 20_000);
  who = await addEmployee(pool, f, 'psph-sum', 40_000);
  await updatePayrollEmployee(who, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
  const march = await newRun(pool, f, 3);
  await calculatePayrollRun(march, f.company);
  await approve(march);
  await updatePayrollEmployee(who, f.company, { taxStatus: 'employee' });
  const april = await newRun(pool, f, 4);
  await calculatePayrollRun(april, f.company);
  await approve(april);
});
afterAll(async () => {
  vi.useRealTimers();
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

describe('IRP5_PSP_NOT_CERTIFIED on the IRP5 summary', () => {
  it('without the entity\'s particulars: March is on no certificate, and the warning says to add them', async () => {
    const m = await pspMessages(f, who);
    expect(m).toHaveLength(1);
    expect(m[0]!.message).toContain('paid as a personal service provider');
    expect(m[0]!.message).toContain('is not on the IRP5 certificate (the months paid as an employee are)');
    expect(m[0]!.message).toContain('It is on no certificate');
    expect(m[0]!.message).toContain('Add them on the employee\'s Work card');
  });

  it('with them: March is on the entity\'s own H certificate in the e@syFile file', async () => {
    await updatePayrollEmployee(who, f.company, {
      taxStatus: 'personal_service_provider', pspEntityType: 'company', pspEntityName: 'Sum Consulting (Pty) Ltd', pspTaxReference: '9012345675',
    } as never);
    const m = await pspMessages(f, who);
    expect(m).toHaveLength(1);
    expect(m[0]!.message).toContain('It is on Sum Consulting (Pty) Ltd\'s own certificate in the e@syFile file: nature of person H');
    expect(m[0]!.message).not.toContain('no certificate');
  });
});
