/**
 * The SDL threshold (s4(b), R500 000 of remuneration over twelve months) counts a non-cash fringe
 * benefit in EARLIER months exactly as it does in this one (estimateAnnualRemuneration). A run
 * line's gross_pay, and the header's total_gross, are cash only since the 3801 loan benefit stopped
 * being paid out; the benefit is on the line's breakdown as an item with `isNonCash: true`.
 *
 * The reviewer's case: eleven months of R41 000 cash + R1 000 benefit, then an identical month,
 * is R504 000 and levied; summing the stored cash gross read it as R493 000 and exempt.
 *
 * History lines are the real calculator's output for that pay (calculatePayrollLine), so the
 * breakdown is the shape the run writes. A line from before the benefit was non-cash (no flag,
 * the benefit inside gross) must count once, not twice.
 * Disposable fixture DB only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { estimateAnnualRemuneration } from '@/modules/accounting/services/payroll/sdlLeviabilityService';
import type { EmployeeComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const companies: string[] = [];
const PERIOD = { month: 3, year: 2026 };

const employee = (id: string, companyId: string): PayrollEmployee => ({
  id, companyId, employeeNumber: 'SDL-NC', firstName: 'Test', lastName: 'Employee', idNumber: null, taxNumber: null,
  employmentType: 'permanent', startDate: new Date('2020-01-01'), dateOfBirth: new Date('1980-01-01'),
  uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
});
const pay = (cash: number, benefit: number, nonCash: boolean): EmployeeComponent[] => [
  { component: { id: 'salary', name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true }, amount: cash },
  {
    component: { id: 'fringe', name: 'Low-interest loan benefit', sarsSourceCode: '3801', componentType: 'earning', isTaxable: true, isUifApplicable: false, isSdlApplicable: true },
    amount: benefit,
    ...(nonCash ? { isNonCash: true } : {}),
  },
];

const ELEVEN = Array.from({ length: 11 }, (_, i) => ({ back: i + 1, status: 'approved' }));

/**
 * A company with eleven approved months before PERIOD, each one line costed by the real
 * calculator. `nonCash` false is a line from before the benefit was non-cash: in gross, no flag.
 * `breakdown` overrides what the line stored (an unreadable one).
 */
async function history(nonCash: boolean, breakdown?: unknown, months: Array<{ back: number; status: string }> = ELEVEN): Promise<string> {
  const company = crypto.randomUUID();
  companies.push(company);
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [company, 'SDL non-cash history']);
  const emp = (await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, status)
     VALUES ($1, 'SDL-NC', 'Test', 'Employee', '2020-01-01', 'active') RETURNING id`, [company])).rows[0]!.id as string;
  for (const { back, status } of months) {
    const index = PERIOD.year * 12 + PERIOD.month - back;
    const period = { month: ((index - 1) % 12) + 1, year: Math.floor((index - 1) / 12) };
    const line = calculatePayrollLine({
      employee: employee(emp, company), components: pay(41_000, 1_000, nonCash), period,
      taxYear: period.month >= 3 ? period.year + 1 : period.year, annualPayrollEstimate: 'defer',
    });
    const run = (await pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, total_gross)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`, [company, period.month, period.year, status, line.grossPay])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, net_pay, component_breakdown)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [run, emp, line.grossPay, line.taxableIncome, line.netPay, JSON.stringify(breakdown ?? line.componentBreakdown)]);
  }
  return company;
}

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ANY($1))', [companies]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = ANY($1)', [companies]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
  } finally {
    await pool.end();
  }
});

describe('SDL threshold: non-cash benefits in earlier months [SDL Act s4(b); Fourth Schedule para 1]', () => {
  it('counts each earlier month\'s benefit, as this month\'s: R504 000, not R493 000', async () => {
    const company = await history(true);
    const stored = (await pool.query(
      'SELECT DISTINCT total_gross::float8 AS g FROM payroll_run_headers WHERE company_id = $1', [company])).rows;
    expect(stored).toEqual([{ g: 41_000 }]); // the history really is cash-only gross
    expect(await estimateAnnualRemuneration(company, PERIOD, 42_000, crypto.randomUUID())).toBe(504_000);
  });

  it('counts a benefit from before it was non-cash once: it is already in that month\'s gross', async () => {
    const company = await history(false);
    expect(await estimateAnnualRemuneration(company, PERIOD, 42_000, crypto.randomUUID())).toBe(504_000);
  });

  it('ignores a cancelled run in the window and a draft before it, whatever benefit they carry', async () => {
    // Approved 1..10 months back; a cancelled run 11 back and a draft 12 back, each R41 000 cash
    // with a benefit raised to R50 000. Counted, they would add to the sum or move the first month
    // (and the divisor): (10 x 42 000 + 42 000) / 11 x 12 = R504 000 only when both are ignored.
    const months = [...ELEVEN.slice(0, 10), { back: 11, status: 'cancelled' }, { back: 12, status: 'draft' }];
    const company = await history(true, undefined, months);
    await pool.query(
      `UPDATE payroll_run_lines SET component_breakdown = (SELECT jsonb_agg(CASE WHEN item->>'isNonCash' = 'true'
         THEN jsonb_set(item, '{amount}', '50000') ELSE item END) FROM jsonb_array_elements(component_breakdown) item)
        WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = $1 AND status IN ('cancelled', 'draft'))`, [company]);
    expect(await estimateAnnualRemuneration(company, PERIOD, 42_000, crypto.randomUUID())).toBe(504_000);
  });

  it('reads only its own company: other tenants\' benefits are not in an empty company\'s basis', async () => {
    await history(true);
    const empty = crypto.randomUUID();
    companies.push(empty);
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [empty, 'SDL non-cash, no history']);
    // No history: this month alone, annualised (x 12 / 1).
    expect(await estimateAnnualRemuneration(empty, PERIOD, 42_000, crypto.randomUUID())).toBe(504_000);
  });

  it('reads a line whose breakdown is not an array as holding no benefit, without failing', async () => {
    const company = await history(true, { not: 'an array' });
    expect(await estimateAnnualRemuneration(company, PERIOD, 42_000, crypto.randomUUID())).toBe(493_000);
  });
});
