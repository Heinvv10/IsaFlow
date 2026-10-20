/**
 * Audit 2026-10-18 P4: a leaver must be in the run that pays them.
 *
 * updatePayrollEmployee sets status='terminated' the moment end_date <= today,
 * and the run used to take only status='active' employees. Capturing a
 * termination dated today or earlier (the normal flow) therefore dropped the
 * employee from that month's run: no final salary, no leave pay-out, no notice
 * pay. The run now takes every employee whose end_date falls in its period,
 * whatever their status, and no employee whose end_date is before it.
 *
 * "Today" is frozen at 2026-03-28, the day the March 2026 run is calculated
 * and the day the run reads components on, so the three leavers' end dates are
 * before, on and after both.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { setTerminationDetails } from '@/modules/accounting/services/payroll/payrollTerminationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const salary = crypto.randomUUID();
const otherSalary = crypto.randomUUID();
const annualLeave = crypto.randomUUID();
const run = crypto.randomUUID();
const otherRun = crypto.randomUUID();

const leftBefore = crypto.randomUUID();
const leftOn = crypto.randomUUID();
const leftAfter = crypto.randomUUID();
const stayer = crypto.randomUUID();
const inactiveLeaver = crypto.randomUUID();
const priorLeaver = crypto.randomUUID();
const staleActive = crypto.randomUUID();
const otherLeaver = crypto.randomUUID();

// R21 670 / 21.67 working days = R1 000 a day (leaveService.calculateTerminationPayout).
const MONTHLY = 21670;
const LEAVE_PAYOUT = 10 * 1000; // 10 unused annual-leave days
const NOTICE_PAY = 20 * 1000; // 30 days' notice, 10 served

async function addEmployee(id: string, companyId: string, num: string, status: string, endDate: string | null) {
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,end_date,status)
     VALUES($1,$2,$3,'Leaver',$3,DATE '2020-01-01',$4::date,$5)`,
    [id, companyId, num, endDate, status],
  );
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from)
     VALUES($1,$2,$3,DATE '2020-01-01')`,
    [id, companyId === company ? salary : otherSalary, MONTHLY],
  );
}

/** The termination flow: reason and notice on the profile, then the end date. */
async function terminate(id: string, companyId: string, endDate: string) {
  await setTerminationDetails(companyId, id, {
    reason: 'resignation', noticePeriodDays: 30, servedNoticeDays: 10,
    severanceWeeksPerYear: null, includeLeavePayout: true,
  });
  await updatePayrollEmployee(id, companyId, { endDate: new Date(`${endDate}T00:00:00`) });
}

async function lines(runId: string) {
  const { rows } = await pool.query(
    'SELECT employee_id, gross_pay, component_breakdown FROM payroll_run_lines WHERE run_id=$1',
    [runId],
  );
  return new Map(rows.map(r => [String(r.employee_id), r]));
}

async function statusOf(id: string) {
  const { rows } = await pool.query('SELECT status FROM payroll_employees WHERE id=$1', [id]);
  return String(rows[0]?.status);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-28T10:00:00+02:00'));

  for (const [id, name] of [[company, 'P4 leaver fixture'], [otherCompany, 'P4 other tenant']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  for (const [id, companyId] of [[salary, company], [otherSalary, otherCompany]] as const) {
    await pool.query(
      `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
       VALUES($1,$2,'Basic salary','3601','earning',true,true,true)`,
      [id, companyId],
    );
  }
  await pool.query(
    `INSERT INTO payroll_leave_types(id,company_id,name,bcea_type) VALUES($1,$2,'Annual leave','annual')`,
    [annualLeave, company],
  );

  await addEmployee(leftBefore, company, 'P4-BEFORE', 'active', null);
  await addEmployee(leftOn, company, 'P4-ON', 'active', null);
  await addEmployee(leftAfter, company, 'P4-AFTER', 'active', null);
  await addEmployee(stayer, company, 'P4-STAYER', 'active', null);
  // Status other than active/terminated, leaving this month: still paid.
  await addEmployee(inactiveLeaver, company, 'P4-INACTIVE', 'inactive', '2026-03-10');
  // Left last month, terminated then: paid in February, not again.
  await addEmployee(priorLeaver, company, 'P4-PRIOR', 'terminated', '2026-02-20');
  // End date captured while still in the future, so status never flipped.
  await addEmployee(staleActive, company, 'P4-STALE', 'active', '2026-02-20');
  await addEmployee(otherLeaver, otherCompany, 'P4-OTHER', 'active', null);

  for (const id of [leftBefore, leftOn, leftAfter]) {
    await pool.query(
      `INSERT INTO payroll_leave_balances(company_id,employee_id,leave_type_id,balance_year,accrued)
       VALUES($1,$2,$3,2026,10)`,
      [company, id, annualLeave],
    );
  }
  await terminate(leftBefore, company, '2026-03-15');
  await terminate(leftOn, company, '2026-03-28');
  await terminate(leftAfter, company, '2026-03-31');
  await terminate(otherLeaver, otherCompany, '2026-03-15');

  for (const [id, companyId] of [[run, company], [otherRun, otherCompany]] as const) {
    await pool.query(
      `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status)
       VALUES($1,$2,3,2026,'draft')`,
      [id, companyId],
    );
  }
});

afterAll(async () => {
  vi.useRealTimers();
  const companies = [company, otherCompany];
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=ANY($1::uuid[])', [[run, otherRun]]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_leave_balances WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_leave_types WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query(
      `DELETE FROM payroll_employee_components WHERE employee_id IN (
         SELECT id FROM payroll_employees WHERE company_id=ANY($1::uuid[]))`,
      [companies],
    );
    await pool.query('DELETE FROM payroll_components WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
  } finally {
    await pool.end();
  }
});

describe('P4: the termination flow sets status as before', () => {
  it('an end date before or on today terminates now; one after today does not', async () => {
    expect(await statusOf(leftBefore)).toBe('terminated');
    expect(await statusOf(leftOn)).toBe('terminated');
    expect(await statusOf(leftAfter)).toBe('active');
  });
});

describe('P4: the March 2026 run pays every employee leaving in March', () => {
  for (const [label, id] of [
    ['end date before the run date (15 Mar)', leftBefore],
    ['end date on the run date (28 Mar)', leftOn],
    ['end date after the run date (31 Mar)', leftAfter],
  ] as const) {
    it(`${label}: final salary, leave pay-out and notice pay`, async () => {
      await calculatePayrollRun(run, company);
      const line = (await lines(run)).get(id);
      expect(line, 'leaver missing from the run').toBeDefined();
      const paid = (line!.component_breakdown as Array<{ componentName: string; amount: number }>)
        .map(c => [c.componentName, Number(c.amount)]);
      expect(paid).toEqual(expect.arrayContaining([
        ['Basic salary', MONTHLY],
        ['Leave Pay-Out (Termination)', LEAVE_PAYOUT],
        ['Notice Pay (Termination)', NOTICE_PAY],
      ]));
      expect(Number(line!.gross_pay)).toBe(MONTHLY + LEAVE_PAYOUT + NOTICE_PAY);
    });
  }

  it('an inactive employee whose end date is in March is paid', async () => {
    await calculatePayrollRun(run, company);
    expect((await lines(run)).has(inactiveLeaver)).toBe(true);
  });

  it('an employee with no end date is still paid', async () => {
    await calculatePayrollRun(run, company);
    expect(Number((await lines(run)).get(stayer)?.gross_pay)).toBe(MONTHLY);
  });
});

describe('P4: the run pays no one who left before its period', () => {
  it('a February leaver is not paid again, whether terminated or still marked active', async () => {
    const summary = await calculatePayrollRun(run, company);
    const paid = await lines(run);
    expect(paid.has(priorLeaver)).toBe(false);
    expect(paid.has(staleActive)).toBe(false);
    expect(new Set(paid.keys())).toEqual(new Set([leftBefore, leftOn, leftAfter, stayer, inactiveLeaver]));
    expect(summary.employeeCount).toBe(5);
  });

  it("another tenant's leaver is in that tenant's run only", async () => {
    await calculatePayrollRun(run, company);
    await calculatePayrollRun(otherRun, otherCompany);
    expect((await lines(run)).has(otherLeaver)).toBe(false);
    expect([...(await lines(otherRun)).keys()]).toEqual([otherLeaver]);
  });
});
