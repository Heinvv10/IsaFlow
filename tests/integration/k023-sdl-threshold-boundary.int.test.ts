// K-023 adjacent cases. The SDL exemption is decided on the employer's total
// remuneration over twelve months, so these cover: the boundary in cents either
// side of R500,000; that a component flagged not SDL-applicable narrows the
// charge but never the gate; that a bonus month does not create a levy and a
// short month does not cancel one; and that the basis stays company-scoped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type Earning = { amount: number; sdlApplicable: boolean };

interface Fixture {
  company: string;
  run: string;
  employees: string[];
}

const fixtures: Fixture[] = [];

// R41,666.66 a month over two employees annualises to R499,999.92 — the largest
// monthly remuneration that still leaves the employer under the exemption. Two
// employees, so the old headcount gate would have levied it.
const under = newFixture();
// One cent more a month annualises to R500,000.04 and the levy is due.
const over = newFixture();
// R101,000 a month is far over the threshold, but only R1,000 of it carries
// is_sdl_applicable: the employer is levied, on that R1,000 alone.
const partlyLeviable = newFixture();
// R35,000 a month for eleven months, then an R80,000 13th-cheque month.
const bonusMonth = newFixture();
// R45,000 a month for eleven months, then a R10,000 short month.
const shortMonth = newFixture();
// A second tenant with its own history, calculated after the levied ones.
const otherTenant = newFixture();

function newFixture(): Fixture {
  const f: Fixture = { company: crypto.randomUUID(), run: crypto.randomUUID(), employees: [] };
  fixtures.push(f);
  return f;
}

async function seed(
  f: Fixture,
  name: string,
  employees: Earning[][],
  priorMonthlyGross?: number,
) {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [f.company, name]);
  for (const earnings of employees) {
    const employeeId = crypto.randomUUID();
    f.employees.push(employeeId);
    await pool.query(
      `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status)
       VALUES($1,$2,$3,'Test','Employee',DATE '2020-01-01','active')`,
      [employeeId, f.company, `K023-${employeeId.slice(0, 8)}`],
    );
    for (const [i, earning] of earnings.entries()) {
      const componentId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
         VALUES($1,$2,$3,'3601','earning',true,true,$4)`,
        [componentId, f.company, `Earning ${employeeId.slice(0, 4)}-${i + 1}`, earning.sdlApplicable],
      );
      await pool.query(
        `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from)
         VALUES($1,$2,$3,DATE '2020-01-01')`,
        [employeeId, componentId, earning.amount],
      );
    }
  }
  // The run under test is 3/2026. Eleven approved runs before it make up the
  // rest of the trailing twelve-month window.
  if (priorMonthlyGross !== undefined) {
    for (let back = 1; back <= 11; back += 1) {
      const index = 2026 * 12 + 3 - back;
      await pool.query(
        `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross)
         VALUES($1,$2,$3,$4,'approved',$5)`,
        [crypto.randomUUID(), f.company, ((index - 1) % 12) + 1,
          Math.floor((index - 1) / 12), priorMonthlyGross],
      );
    }
  }
  await pool.query(
    `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status)
     VALUES($1,$2,3,2026,'draft')`,
    [f.run, f.company],
  );
}

beforeAll(async () => {
  await seed(under, 'K023 just under', [
    [{ amount: 20833.33, sdlApplicable: true }],
    [{ amount: 20833.33, sdlApplicable: true }],
  ]);
  await seed(over, 'K023 just over', [[{ amount: 41666.67, sdlApplicable: true }]]);
  await seed(partlyLeviable, 'K023 partly leviable', [[
    { amount: 100000, sdlApplicable: false },
    { amount: 1000, sdlApplicable: true },
  ]]);
  await seed(bonusMonth, 'K023 bonus month', [[{ amount: 80000, sdlApplicable: true }]], 35000);
  await seed(shortMonth, 'K023 short month', [[{ amount: 10000, sdlApplicable: true }]], 45000);
  await seed(otherTenant, 'K023 other tenant', [
    [{ amount: 5000, sdlApplicable: true }],
    [{ amount: 5000, sdlApplicable: true }],
  ], 10000);
});

afterAll(async () => {
  const companies = fixtures.map(f => f.company);
  const employees = fixtures.flatMap(f => f.employees);
  try {
    await pool.query(
      `DELETE FROM payroll_run_lines WHERE run_id IN
       (SELECT id FROM payroll_run_headers WHERE company_id=ANY($1::uuid[]))`, [companies]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=ANY($1::uuid[])',
      [employees]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
  } finally {
    await pool.end();
  }
});

describe('K-023 SDL threshold boundary', () => {
  it('exempts an employer whose annualised remuneration stays under R500,000', async () => {
    const summary = await calculatePayrollRun(under.run, under.company);
    expect(summary.totalGross).toBe(41666.66);
    expect(summary.totalSdl).toBe(0);
  });

  it('levies the employer one cent a month above that boundary', async () => {
    const summary = await calculatePayrollRun(over.run, over.company);
    expect(summary.totalSdl).toBe(416.67);
  });

  it('gates on total remuneration but charges only the SDL-applicable part', async () => {
    const summary = await calculatePayrollRun(partlyLeviable.run, partlyLeviable.company);
    expect(summary.totalGross).toBe(101000);
    // R1.212m of remuneration, so the levy is due; 1% of the R1,000 that carries it.
    expect(summary.totalSdl).toBe(10);
  });

  it('does not let a 13th-cheque month create a levy for an exempt employer', async () => {
    // Eleven months at R35,000 plus R80,000 = R465,000 over the year, under the
    // threshold. Annualising this month alone would have read R960,000.
    const summary = await calculatePayrollRun(bonusMonth.run, bonusMonth.company);
    expect(summary.totalSdl).toBe(0);
  });

  it('does not let a short month cancel the levy for a liable employer', async () => {
    // Eleven months at R45,000 plus R10,000 = R505,000 over the year, over the
    // threshold. Annualising this month alone would have read R120,000.
    const summary = await calculatePayrollRun(shortMonth.run, shortMonth.company);
    expect(summary.totalSdl).toBe(100);
  });

  it('reads only its own tenant history and leaves that tenant exempt', async () => {
    const summary = await calculatePayrollRun(otherTenant.run, otherTenant.company);
    expect(summary.totalSdl).toBe(0);
    const lines = await pool.query(
      'SELECT sdl FROM payroll_run_lines WHERE run_id=$1::uuid', [otherTenant.run]);
    expect(lines.rows).toHaveLength(2);
    expect(lines.rows.every(row => Number(row.sdl) === 0)).toBe(true);
  });
});
