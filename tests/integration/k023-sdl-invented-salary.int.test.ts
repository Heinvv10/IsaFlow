// K-023 RED: the SDL leviability test uses an invented R25,000 per employee.
//   const annualPayrollEstimate = employees.length * 25_000 * 12;
// The R500,000 SDL registration threshold (taxTables.ts:47) is therefore decided
// by HEADCOUNT, not remuneration: one employee is always treated as R300,000 and
// exempt however much they earn, and two minimum-wage employees are always
// treated as R600,000 and levied.
// Source: src/modules/accounting/services/payroll/payrollRunService.ts:143
//         src/modules/accounting/services/payroll/sdlEngine.ts:8-10
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Company A: one employee on R100,000/month. Actual annual payroll R1,200,000,
// well over the threshold, so SDL of 1% is payable.
const bigA = crypto.randomUUID();
const empA = crypto.randomUUID();
const compA = crypto.randomUUID();
const runA = crypto.randomUUID();

// Company B: two employees on R5,000/month. Actual annual payroll R120,000,
// under the threshold, so no SDL is payable.
const smallB = crypto.randomUUID();
const empB1 = crypto.randomUUID();
const empB2 = crypto.randomUUID();
const compB = crypto.randomUUID();
const runB = crypto.randomUUID();

async function seed(company: string, name: string, comp: string, run: string,
                   employees: Array<{ id: string; num: string; salary: number }>) {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, name]);
  await pool.query(
    `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
     VALUES($1,$2,'Basic salary','3601','earning',true,true,true)`,
    [comp, company],
  );
  for (const e of employees) {
    await pool.query(
      `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status)
       VALUES($1,$2,$3,'Test','Employee',DATE '2020-01-01','active')`,
      [e.id, company, e.num],
    );
    await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from)
       VALUES($1,$2,$3,DATE '2020-01-01')`,
      [e.id, comp, e.salary],
    );
  }
  await pool.query(
    `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status)
     VALUES($1,$2,3,2026,'draft')`,
    [run, company],
  );
}

beforeAll(async () => {
  await seed(bigA, 'K023 one high earner', compA, runA, [{ id: empA, num: 'K023A-1', salary: 100000 }]);
  await seed(smallB, 'K023 two low earners', compB, runB, [
    { id: empB1, num: 'K023B-1', salary: 5000 },
    { id: empB2, num: 'K023B-2', salary: 5000 },
  ]);
});

afterAll(async () => {
  const companies = [bigA, smallB];
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=ANY($1::uuid[])', [[runA, runB]]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=ANY($1::uuid[])',
      [[empA, empB1, empB2]]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
  } finally {
    await pool.end();
  }
});

describe('K-023 SDL leviability', () => {
  it('levies SDL on a single employee whose remuneration exceeds the R500,000 threshold', async () => {
    const summary = await calculatePayrollRun(runA, bigA);
    // R100,000 leviable at 1% = R1,000 per month.
    expect(summary.totalSdl).toBe(1000);
  });

  it('does not levy SDL on two employees whose combined payroll is under the threshold', async () => {
    const summary = await calculatePayrollRun(runB, smallB);
    // R120,000 annual payroll: below R500,000, so the employer is not registered for SDL.
    expect(summary.totalSdl).toBe(0);
  });
});
