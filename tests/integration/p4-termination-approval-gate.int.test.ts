/**
 * Audit 2026-10-18 P4, review round 2: two runs calculated before either was
 * approved can both carry the same employee's termination pay-outs (the
 * calculation-time check, findPaidTerminationRun, saw no approved run). Once
 * one is approved, the approval gate refuses the other until it is
 * recalculated, and the recalculation leaves the pay-outs out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { judgePayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalGate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const febRun = crypto.randomUUID();
const marchRun = crypto.randomUUID();
const otherFebRun = crypto.randomUUID();
const paidTwice = crypto.randomUUID();
const paidOnce = crypto.randomUUID();

const NOTICE = { componentId: 'synthetic:termination:notice-pay', componentName: 'Notice Pay (Termination)', amount: 5000 };
const SALARY = { componentId: crypto.randomUUID(), componentName: 'Basic salary', amount: 20000 };

async function addLine(runId: string, employeeId: string, breakdown: unknown[]) {
  await pool.query(
    `INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,net_pay,component_breakdown)
     VALUES($1,$2,25000,25000,$3::jsonb)`,
    [runId, employeeId, JSON.stringify(breakdown)],
  );
}

beforeAll(async () => {
  for (const [id, name] of [[company, 'P4 gate'], [otherCompany, 'P4 gate other']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  for (const [id, num] of [[paidTwice, 'E-TWICE'], [paidOnce, 'E-ONCE']] as const) {
    await pool.query(
      `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,end_date,status)
       VALUES($1,$2,$3,'Gate',$3,DATE '2020-01-01',DATE '2026-03-10','terminated')`,
      [id, company, num],
    );
  }
  await pool.query(
    `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status)
     VALUES($1,$3,2,2026,'approved'),($2,$3,3,2026,'calculated')`,
    [febRun, marchRun, company],
  );
  // February (approved) paid E-TWICE's notice pay; March was calculated before
  // that and carries it again. E-ONCE's is only in March.
  await addLine(febRun, paidTwice, [SALARY, NOTICE]);
  await addLine(marchRun, paidTwice, [SALARY, NOTICE]);
  await addLine(marchRun, paidOnce, [SALARY, NOTICE]);
});

afterAll(async () => {
  const companies = [company, otherCompany];
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=ANY($1::uuid[])', [[febRun, marchRun, otherFebRun]]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
  } finally {
    await pool.end();
  }
});

describe('P4: the approval gate refuses termination pay-outs already paid', () => {
  it('names the employee and the run that paid them', async () => {
    const gate = await judgePayrollApproval(company, marchRun);
    expect(gate?.blocker?.code).toBe('termination_already_paid');
    expect(gate?.blocker?.detail).toContain('E-TWICE (2026-02)');
    expect(gate?.blocker?.detail).not.toContain('E-ONCE');
  });

  it('does not refuse once the run no longer carries them (recalculated)', async () => {
    await pool.query('UPDATE payroll_run_lines SET component_breakdown=$3::jsonb WHERE run_id=$1 AND employee_id=$2',
      [marchRun, paidTwice, JSON.stringify([SALARY])]);
    const gate = await judgePayrollApproval(company, marchRun);
    expect(gate?.blocker?.code).not.toBe('termination_already_paid');
    await pool.query('UPDATE payroll_run_lines SET component_breakdown=$3::jsonb WHERE run_id=$1 AND employee_id=$2',
      [marchRun, paidTwice, JSON.stringify([SALARY, NOTICE])]);
  });

  it("ignores another tenant's approved run", async () => {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1', [febRun]);
    await pool.query(
      `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,2,2026,'approved')`,
      [otherFebRun, otherCompany],
    );
    await addLine(otherFebRun, paidTwice, [SALARY, NOTICE]);
    const gate = await judgePayrollApproval(company, marchRun);
    expect(gate?.blocker?.code).not.toBe('termination_already_paid');
  });
});
