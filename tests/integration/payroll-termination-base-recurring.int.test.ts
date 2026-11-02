/**
 * The termination base is the leaver's RECURRING earnings in force on their end date (Hein 2026-11-02): leave pay-out,
 * notice pay and the calculated severance are figured on it, in the final run, in a later severance-only run and in
 * the termination preview alike. A once-off (a bonus) in the leaving month is paid on the line but is not part of the
 * base. Before, the run used every earning it read (once-offs included) and the preview every earning on the end date.
 *
 * R21 670 a month / 21.67 working days = R1 000 a day: 10 unused leave days = R10 000, 20 unserved notice days = R20 000.
 * With the R2 167 bonus in the base (before) the day was R1 100: R11 000 and R22 000.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import termination from '../../pages/api/payroll/employees/[id]/termination';
import type { Route } from './w3-01-payroll.helpers';
import {
  calculateRun, cleanSeveranceFixtures, createRunFor, runLine, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';
import { computeTerminationPreview, setTerminationDetails, yearsOfService } from '@/modules/accounting/services/payroll/payrollTerminationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const MONTHLY = 21_670;
const EXIT = '2026-03-15';
const fixtures: Record<'plain' | 'bonus', SeveranceFixture> = {} as never;
const severanceOn = (monthly: number) => computeTerminationPreview({
  monthlySalary: monthly, unusedLeaveDays: 0, noticePeriodDays: 0, servedNoticeDays: 0, severanceWeeksPerYear: 1,
  yearsOfService: yearsOfService('2020-01-01', EXIT), includeLeavePayout: false, reason: 'retrenchment',
}).severancePay;

async function seed(name: string, bonus: boolean): Promise<SeveranceFixture> {
  const f = await seedRetrenchedEmployee(pool, EXIT, name, MONTHLY);
  await setTerminationDetails(f.company, f.employee, {
    reason: 'retrenchment', noticePeriodDays: 30, servedNoticeDays: 10, severanceWeeksPerYear: 1, includeLeavePayout: true,
  });
  const leave = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_leave_types(id,company_id,name,bcea_type) VALUES($1,$2,'Annual leave','annual')", [leave, f.company]);
  await pool.query(
    'INSERT INTO payroll_leave_balances(company_id,employee_id,leave_type_id,balance_year,accrued) VALUES($1,$2,$3,2026,10)',
    [f.company, f.employee, leave]);
  if (bonus) {
    const comp = crypto.randomUUID();
    await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Bonus','3605','earning')", [comp, f.company]);
    await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
       VALUES($1,$2,2167,'2026-03-05','2026-03-31',false)`, [f.employee, comp]);
  }
  return f;
}

const paidAs = (line: { component_breakdown: unknown }, name: string) =>
  (line.component_breakdown as Array<{ componentName: string; amount: number }>).find(c => c.componentName === name)?.amount;

beforeAll(async () => {
  fixtures.plain = await seed('Termination base, no once-off', false);
  fixtures.bonus = await seed('Termination base, once-off bonus', true);
});

afterAll(async () => {
  try {
    const ids = Object.values(fixtures).map(f => f.company);
    await pool.query('DELETE FROM payroll_leave_balances WHERE company_id=ANY($1)', [ids]);
    await pool.query('DELETE FROM payroll_leave_types WHERE company_id=ANY($1)', [ids]);
    await cleanSeveranceFixtures(pool, Object.values(fixtures));
  } finally { await pool.end(); }
});

describe.each([['plain', 0], ['bonus', 2167]] as const)('leaver %s (once-off R%d in March)', (key, bonus) => {
  it('the final run: leave pay-out and notice pay on the recurring salary; the bonus is paid but not in the base', async () => {
    const f = fixtures[key];
    const march = await createRunFor(f, 3);
    await calculateRun(f, march);
    const line = await runLine(pool, march, f.employee);
    expect(paidAs(line, 'Leave Pay-Out (Termination)')).toBe(10_000);
    expect(paidAs(line, 'Notice Pay (Termination)')).toBe(20_000);
    expect(paidAs(line, 'Bonus')).toBe(bonus || undefined);
    expect(line.gross).toBeCloseTo(MONTHLY + bonus + 30_000, 2);
    const awaiting = (line.validation_results as Array<{ code: string; message: string }>).find(v => v.code === 'SEVERANCE_AWAITING_DIRECTIVE');
    expect(awaiting?.message).toContain(severanceOn(MONTHLY).toFixed(2));
  });

  it('the termination preview agrees: same base, same leave, notice and severance', async () => {
    const f = fixtures[key];
    const out = await f.call(termination as Route, 'GET', `/api/payroll/employees/${f.employee}/termination`, f.employee);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    const data = out.body.data as { context: { monthlySalary: number }; preview: { leavePayout: number; noticePay: number; severancePay: number } };
    expect(data.context.monthlySalary).toBe(MONTHLY);
    expect(data.preview).toMatchObject({ leavePayout: 10_000, noticePay: 20_000, severancePay: severanceOn(MONTHLY) });
  });
});
