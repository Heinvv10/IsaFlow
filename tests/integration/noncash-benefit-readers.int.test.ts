/**
 * Readers of run totals that must count a non-cash fringe benefit (the 3801 loan benefit, a
 * breakdown item flagged `isNonCash`, outside gross_pay / total_gross) as remuneration:
 *  - EMP201 `totalTaxableRemuneration` (the EMP201 page, the submission modal, MCP emp201_status);
 *  - the IRP5 summary's readiness: an employee paid only a benefit has a certificate to issue.
 * A line from before the flag (benefit inside gross pay, item unflagged) counts once.
 * Lines are the real calculator's output. Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import summaryRoute from '../../pages/api/payroll/irp5/summary';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import type { EmployeeComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const ids = { flagged: '', legacy: '', benefitOnly: '' };

const pay = (cash: number, benefit: number, nonCash: boolean): EmployeeComponent[] => [
  ...(cash > 0 ? [{ component: { id: 'salary', name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning' as const, isTaxable: true, isUifApplicable: true, isSdlApplicable: true }, amount: cash }] : []),
  {
    component: { id: 'fringe', name: 'Low-interest loan benefit', sarsSourceCode: '3801', componentType: 'earning', isTaxable: true, isUifApplicable: false, isSdlApplicable: true },
    amount: benefit,
    ...(nonCash ? { isNonCash: true } : {}),
  },
];

async function employee(number: string, last: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
     VALUES ($1, $2, 'Test', $3, '2020-01-01', '1980-01-01', '8001015009087', '0123456789') RETURNING id`, [company, number, last])).rows[0]!.id;
}

/** One approved run for March 2026; each line costed by the real calculator. */
async function marchRun(lines: Array<{ employeeId: string; components: EmployeeComponent[] }>): Promise<void> {
  const costed = lines.map(({ employeeId, components }) => ({
    employeeId,
    line: calculatePayrollLine({
      employee: {
        id: employeeId, companyId: company, employeeNumber: 'X', firstName: 'Test', lastName: 'X', idNumber: null, taxNumber: null,
        employmentType: 'permanent', startDate: new Date('2020-01-01'), dateOfBirth: new Date('1980-01-01'),
        uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
      } satisfies PayrollEmployee,
      components, period: { month: 3, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 1_000_000,
    }),
  }));
  const gross = costed.reduce((s, c) => s + c.line.grossPay, 0);
  const run = (await pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, total_gross, total_paye)
     VALUES ($1, 3, 2026, 'approved', $2, $3) RETURNING id`,
    [company, gross, costed.reduce((s, c) => s + c.line.paye.monthlyPaye, 0)])).rows[0]!.id;
  for (const { employeeId, line } of costed) {
    await pool.query(
      `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, sdl, net_pay, component_breakdown)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [run, employeeId, line.grossPay, line.taxableIncome, line.paye.monthlyPaye, line.sdl, line.netPay, JSON.stringify(line.componentBreakdown)]);
  }
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [company, 'Non-cash readers']);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [company, user]);
  ids.flagged = await employee('NC-1', 'Flagged');
  ids.legacy = await employee('NC-2', 'Legacy');
  ids.benefitOnly = await employee('NC-3', 'BenefitOnly');
  await marchRun([
    { employeeId: ids.flagged, components: pay(41_000, 1_000, true) },
    // Costed before the flag: the benefit paid inside gross pay, its item unflagged.
    { employeeId: ids.legacy, components: pay(41_000, 1_000, false) },
    // No cash at all this year, only the benefit.
    { employeeId: ids.benefitOnly, components: pay(0, 500, true) },
  ]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = $1)', [company]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally {
    await pool.end();
  }
});

describe('readers that count a non-cash benefit as remuneration', () => {
  it('EMP201: taxable remuneration is cash plus flagged benefits, a pre-flag benefit once (R42k + R42k + R500)', async () => {
    const stored = (await pool.query('SELECT total_gross::float8 AS g FROM payroll_run_headers WHERE company_id = $1', [company])).rows[0]!.g;
    expect(stored).toBe(83_000); // 41 000 + 42 000 (legacy, benefit inside) + 0
    const emp201 = await generateEMP201(company, '2026-03-01', '2026-03-31');
    expect(emp201.totalTaxableRemuneration).toBe(84_500);
  });

  it('IRP5 summary: an employee paid only a benefit is not "missing" (no payroll)', async () => {
    const token = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const req = request({ 'sb-access-token': token, active_company_id: company }, 'GET') as never as { url: string; query: Record<string, string> };
    req.url = '/api/payroll/irp5/summary';
    req.query = { taxYear: '2027' };
    const result = response();
    await summaryRoute(req as never, result.res as never);
    expect(result.state.statusCode).toBe(200);
    const rows = (result.state.body as { data: { employees: Array<{ employeeId: string; status: string; totalGross: number; totalFringeBenefits: number }> } }).data.employees;
    const only = rows.find((e) => e.employeeId === ids.benefitOnly)!;
    expect(only).toMatchObject({ totalGross: 0, totalFringeBenefits: 500 });
    expect(only.status).not.toBe('missing');
    expect(rows.find((e) => e.employeeId === ids.flagged)).toMatchObject({ totalGross: 41_000, totalFringeBenefits: 1_000 });
    expect(rows.find((e) => e.employeeId === ids.legacy)).toMatchObject({ totalGross: 42_000, totalFringeBenefits: 0 });
  });
});
