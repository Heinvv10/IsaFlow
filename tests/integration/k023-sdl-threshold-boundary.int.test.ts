// K-023 adjacent cases: the SDL threshold is decided by the run's own leviable
// remuneration annualised, so it has to sit on the right side of R500,000 in
// cents, ignore earnings flagged not SDL-applicable, and stay company-scoped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type Earning = { amount: number; sdlApplicable: boolean };

interface Fixture {
  company: string;
  run: string;
  employee: string;
  components: string[];
}

const fixtures: Fixture[] = [];

// R41,666.66 a month annualises to R499,999.92 — the largest monthly leviable
// amount that still leaves the employer under the R500,000 exemption.
const under = newFixture();
// One cent more a month annualises to R500,000.04 and the levy is due.
const over = newFixture();
// Gross far above the threshold, but only R1,000 of it is SDL-leviable.
const nonLeviable = newFixture();
// A second tenant, exempt, calculated after the levied one.
const otherTenant = newFixture();

function newFixture(): Fixture {
  const f: Fixture = {
    company: crypto.randomUUID(),
    run: crypto.randomUUID(),
    employee: crypto.randomUUID(),
    components: [],
  };
  fixtures.push(f);
  return f;
}

async function seed(f: Fixture, name: string, earnings: Earning[]) {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [f.company, name]);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status)
     VALUES($1,$2,$3,'Test','Employee',DATE '2020-01-01','active')`,
    [f.employee, f.company, `K023-${f.employee.slice(0, 8)}`],
  );
  for (const [i, earning] of earnings.entries()) {
    const componentId = crypto.randomUUID();
    f.components.push(componentId);
    await pool.query(
      `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
       VALUES($1,$2,$3,'3601','earning',true,true,$4)`,
      [componentId, f.company, `Earning ${i + 1}`, earning.sdlApplicable],
    );
    await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from)
       VALUES($1,$2,$3,DATE '2020-01-01')`,
      [f.employee, componentId, earning.amount],
    );
  }
  await pool.query(
    `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status)
     VALUES($1,$2,3,2026,'draft')`,
    [f.run, f.company],
  );
}

beforeAll(async () => {
  await seed(under, 'K023 just under', [{ amount: 41666.66, sdlApplicable: true }]);
  await seed(over, 'K023 just over', [{ amount: 41666.67, sdlApplicable: true }]);
  await seed(nonLeviable, 'K023 mostly not leviable', [
    { amount: 100000, sdlApplicable: false },
    { amount: 1000, sdlApplicable: true },
  ]);
  await seed(otherTenant, 'K023 other tenant', [{ amount: 5000, sdlApplicable: true }]);
});

afterAll(async () => {
  const companies = fixtures.map(f => f.company);
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=ANY($1::uuid[])',
      [fixtures.map(f => f.run)]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=ANY($1::uuid[])',
      [fixtures.map(f => f.employee)]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
  } finally {
    await pool.end();
  }
});

describe('K-023 SDL threshold boundary', () => {
  it('exempts an employer whose annualised leviable remuneration stays under R500,000', async () => {
    const summary = await calculatePayrollRun(under.run, under.company);
    expect(summary.totalSdl).toBe(0);
  });

  it('levies the employer one cent a month above that boundary', async () => {
    const summary = await calculatePayrollRun(over.run, over.company);
    expect(summary.totalSdl).toBe(416.67);
  });

  it('decides leviability on SDL-applicable earnings, not on gross pay', async () => {
    const summary = await calculatePayrollRun(nonLeviable.run, nonLeviable.company);
    expect(summary.totalGross).toBe(101000);
    expect(summary.totalSdl).toBe(0);
  });

  it('leaves a second tenant exempt and its lines at zero SDL', async () => {
    const summary = await calculatePayrollRun(otherTenant.run, otherTenant.company);
    expect(summary.totalSdl).toBe(0);
    const lines = await pool.query(
      'SELECT sdl FROM payroll_run_lines WHERE run_id=$1::uuid',
      [otherTenant.run],
    );
    expect(lines.rows).toHaveLength(1);
    expect(Number(lines.rows[0].sdl)).toBe(0);
  });
});
