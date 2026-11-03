/**
 * Review follow-up: pre-deduction remuneration is one rule in the calculator,
 * YTD period count, reopen history and medical-record completeness.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loadMedicalRecord } from '@/modules/accounting/services/payroll/payrollMedicalRecord';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import {
  approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, reopenRun,
  seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

async function component(
  f: SeveranceFixture,
  name: string,
  code: string,
  type: 'earning' | 'deduction',
  amount: number,
  from: string,
  to?: string,
  taxable = true,
): Promise<void> {
  const id = String((await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [f.company, name, code, type, taxable])).rows[0]!.id);
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5)`, [f.employee, id, amount, from, to ?? null]);
}

describe('pre-deduction remuneration identity', () => {
  it('counts salary despite an equal 3605 clawback, so the next salary month deducts R630', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-12-31', 'remuneration: negative 3605');
    fixtures.push(f);
    await component(f, 'Bonus clawback', '3605', 'earning', -20_000, '2026-06-01', '2026-06-30');
    await component(f, 'Rounding allowance', '3702', 'earning', 1, '2026-06-01', '2026-06-30', false);

    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await approveRun(f, june)).statusCode).toBe(200);
    // A line written before migration 913 has no stored taxable split. Its
    // breakdown still proves that salary was paid before the 3605 clawback.
    await pool.query(
      'UPDATE payroll_run_lines SET periodic_taxable = NULL, annual_taxable = NULL WHERE run_id = $1',
      [june]);
    const ytd = await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 7 }, [f.employee]);
    expect(ytd.get(f.employee)).toMatchObject({ periods: 1, periodicTaxable: 0 });

    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    const line = (await pool.query(
      'SELECT paye::float8 AS paye FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2',
      [july, f.employee])).rows[0]!;
    expect(line.paye).toBe(630);
  });

  it('keeps a fully donated salary in reopen history and accepts its medical credit catch-up record', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-12-31', 'remuneration: donated medical');
    fixtures.push(f);
    await pool.query(
      `UPDATE payroll_employees
          SET status = 'active', uif_excluded = true, medical_aid_main_member = true, medical_aid_dependants_count = 0
        WHERE id = $1`, [f.employee]);
    await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
       VALUES ($1, '2175', 'Other Employee Deductions Payable', 'liability', 'credit', 1)`, [f.company]);

    const march = await createRunFor(f, 3);
    await calculateRun(f, march);
    expect((await approveRun(f, march)).statusCode).toBe(200);
    // Simulate the latest earlier line predating the medical-credit record columns.
    await pool.query('UPDATE payroll_run_lines SET medical_credit = NULL WHERE run_id = $1', [march]);

    await component(f, 'Section 18A donation', '4030', 'deduction', 20_000, '2026-04-01', '2026-04-30');
    const april = await createRunFor(f, 4);
    await calculateRun(f, april);
    const aprilLine = (await pool.query(
      `SELECT taxable_income::float8 AS taxable, medical_credit::float8 AS credit
         FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2`, [april, f.employee])).rows[0]!;
    expect(aprilLine).toEqual({ taxable: 0, credit: 630 });
    expect((await approveRun(f, april)).statusCode).toBe(200);
    await pool.query(
      'UPDATE payroll_run_lines SET periodic_taxable = NULL, annual_taxable = NULL WHERE run_id = $1',
      [april]);

    const ytd = await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 5 }, [f.employee]);
    expect(ytd.get(f.employee)).toMatchObject({ periods: 2, periodicTaxable: 20_000 });

    const medical = await loadMedicalRecord(f.company, { start: '2026-03-01', end: '2027-02-01' }, [f.employee]);
    expect(medical.get(f.employee)).toMatchObject({ credit: 630, recorded: true });

    await pool.query(
      'UPDATE payroll_run_lines SET periodic_taxable = 0, annual_taxable = 0 WHERE run_id = $1',
      [april]);
    expect((await reopenRun(f, april)).statusCode).toBe(200);
    const taxed = (await pool.query(
      'SELECT approved_taxed_employees AS employees FROM payroll_run_headers WHERE id = $1', [april])).rows[0]!.employees as string[];
    expect(taxed).toContain(f.employee);
  });

  it('caps a pre-948 restoration at remuneration net of a 3605 clawback', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-12-31', 'remuneration: legacy retirement clawback');
    fixtures.push(f);
    await component(f, 'Bonus clawback', '3605', 'earning', -10_000, '2026-03-01', '2026-03-31');
    await component(f, 'Non-taxable allowance', '3702', 'earning', 10_000, '2026-03-01', '2026-03-31', false);
    await component(f, 'Retirement annuity', '4006', 'deduction', 15_000, '2026-03-01', '2026-03-31');

    const march = await createRunFor(f, 3);
    await calculateRun(f, march);
    await pool.query("UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1", [march]);
    // Before migration 948 the calculator treated the contribution as an
    // uncapped taxable deduction: R20 000 salary - R10 000 clawback - R15 000,
    // floored at nil. Restoration may add back only the R10 000 that existed.
    await pool.query(
      `UPDATE payroll_run_lines
          SET retirement_contributions = NULL, retirement_deduction = NULL,
              periodic_taxable = 0, annual_taxable = 0, taxable_income = 0,
              component_breakdown = (SELECT jsonb_agg(item - 'retirementContribution')
                FROM jsonb_array_elements(component_breakdown) item)
        WHERE run_id = $1`, [march]);

    const ytd = await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 4 }, [f.employee]);
    expect(ytd.get(f.employee)).toMatchObject({
      periods: 1,
      periodicTaxable: 10_000,
      annualPayments: 0,
      retirementContributions: 15_000,
      retirementDeduction: 15_000,
    });
  });
});
