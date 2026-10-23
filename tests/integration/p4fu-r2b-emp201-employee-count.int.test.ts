/**
 * PAYE 4a follow-ups round 2, R5: the EMP201's employee count is the number of
 * distinct employees paid in the period, by a declarable run or by a SARS
 * directive paid outside payroll (applyTaxDirective). It was the largest
 * header count among the runs, so a leaver paid only a stand-alone lump sum
 * was not counted, and two runs in one window paying different people
 * counted only the bigger one. No SARS text in hand defines the field (the
 * EMP201 return carries PAYE, SDL, UIF and ETI amounts); the definition is
 * IsaFlow's, documented in emp201Service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { createTaxDirective, updateTaxDirectiveStatus } from '@/modules/accounting/services/payroll/taxDirectiveService';
import {
  applyStandalone, approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let f: SeveranceFixture;
let active = '';
let joiner = '';

async function employee(number: string, start: string, salary: number): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth)
     VALUES ($1, $2, 'Emp', $2, $3::date, '1985-01-01') RETURNING id`, [f.company, number, start])).rows[0]!.id;
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from)
     SELECT $1, id, $2, '2020-01-01' FROM payroll_components WHERE company_id = $3 AND sars_source_code = '3601'`,
    [id, salary, f.company]);
  return id;
}

async function lumpSum(employeeId: string, number: string, paymentDate: string): Promise<void> {
  const d = await createTaxDirective(f.company, {
    employee_id: employeeId, employee_name: 'Emp', directive_number: number, directive_type: 'lump_sum',
    amount: 5_000, tax_rate: 0.2, effective_date: '2026-05-01',
  }, f.admin);
  await updateTaxDirectiveStatus(f.company, d.id, 'approved', f.admin);
  const paid = await applyStandalone(f, d.id, paymentDate);
  expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);
}

beforeAll(async () => {
  // The fixture's own employee leaves on 31 March and is paid in no run after it.
  f = await seedRetrenchedEmployee(pool, '2026-03-31', 'R5 EMP201 count');
  active = await employee('R5-ACT', '2021-01-01', 15_000);
  joiner = await employee('R5-JOIN', '2026-05-01', 12_000);
  const april = await createRunFor(f, 4);
  await calculateRun(f, april);
  expect((await approveRun(f, april)).statusCode).toBe(200);
  const may = await createRunFor(f, 5);
  await calculateRun(f, may);
  expect((await approveRun(f, may)).statusCode).toBe(200);
  // May: the leaver paid only a stand-alone lump sum, and an employee the May run pays also paid one.
  await lumpSum(f.employee, 'R5LEAVER1', '2026-05-20');
  await lumpSum(active, 'R5ACTIVE1', '2026-05-21');
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f].filter(Boolean)); } finally { await pool.end(); }
});

describe('R5: EMP201 employee count = distinct employees paid in the period', () => {
  it('the runs pay who the test expects', async () => {
    const paidBy = async (month: number) => (await pool.query(
      `SELECT l.employee_id FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id
        WHERE h.company_id = $1 AND h.period_month = $2 ORDER BY 1`, [f.company, month])).rows.map(r => r.employee_id);
    expect(await paidBy(4)).toEqual([active]);
    expect((await paidBy(5)).sort()).toEqual([active, joiner].sort());
  });

  it('May: the run\'s two employees plus the leaver paid only a stand-alone directive, the run employee\'s own payment counted once', async () => {
    const may = await generateEMP201(f.company, '2026-05-01', '2026-05-31');
    expect(may.payrollRuns.map(r => r.employeeCount)).toEqual([2]);
    expect(may.directivePayments).toHaveLength(2);
    expect(may.employeeCount).toBe(3);
  });

  it('a window over April and May counts each person once across the runs and the payments', async () => {
    const both = await generateEMP201(f.company, '2026-04-01', '2026-05-31');
    expect(both.employeeCount).toBe(3);
  });

  it('a period with only the stand-alone payments counts their payees', async () => {
    const onlyPayments = await generateEMP201(f.company, '2026-05-20', '2026-05-21');
    expect(onlyPayments.payrollRuns).toEqual([]);
    expect(onlyPayments.employeeCount).toBe(2);
  });
});
