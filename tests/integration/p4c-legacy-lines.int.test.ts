/**
 * PAYE 4c review (#891): a year to date that includes lines written before migration 948 (retirement_* NULL,
 * no `retirementContribution` marks in the breakdown). Such a line was taxed by the old calculator: a 4001/4003/
 * 4006 deduction flagged taxable came off its periodic_taxable uncapped, one flagged non-taxable was not deducted.
 * payrollRetirementRecord derives its contributions from the breakdown (as payrollMedicalRecord derives pre-926
 * fees) and adds the taxable-flagged ones back to periodic pay, so the next month's PAYE and the certificate are
 * what they are for lines that recorded the figures. Production had no such line in tax year 2027 (read-only
 * census 2026-10-26: 0 of 167 lines); dev's Demo has them.
 *
 * Two identical employees, R30 000 with a pension (4001, flagged non-taxable) of R3 000 and an RA (4006, flagged
 * taxable) of R1 000. March and April are approved by 4c; then one employee's lines are rewritten as the old
 * calculator stored them. May's PAYE, May's year to date and the certificate must be the same for both.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import createRun from '../../pages/api/payroll/runs';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { approveRun, calculateRun, cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

async function seed(name: string): Promise<{ f: SeveranceFixture; runs: string[] }> {
  const f = await seedEmployee(pool, fixtures, name, 30_000);
  await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
    VALUES ($1, '2175', 'Other Employee Deductions Payable', 'liability', 'credit', 1)`, [f.company]);
  await pool.query(`UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
    sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
    physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181' WHERE id = $1`, [f.company]);
  for (const [name2, code, taxable, amount] of [['Pension', '4001', false, 3_000], ['RA', '4006', true, 1_000]] as const) {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, $2, $3, 'deduction', $4) RETURNING id`, [f.company, name2, code, taxable])).rows[0]!.id;
    await pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from)
      VALUES ($1, $2, $3, '2026-03-01')`, [f.employee, id, amount]);
  }
  const runs: string[] = [];
  for (const month of [3, 4]) runs.push(await pay(f, month));
  return { f, runs };
}

async function pay(f: SeveranceFixture, month: number): Promise<string> {
  const made = await f.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year: 2026 } });
  const id = String(made.body.data!.id);
  await calculateRun(f, id);
  expect((await approveRun(f, id)).statusCode).toBe(200);
  return id;
}

async function retirementCodes(f: SeveranceFixture): Promise<string[]> {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
  req.url = '/api/payroll/irp5/easyfile-export?taxYear=2027';
  req.query = { taxYear: '2027' };
  const out = response();
  let file = '';
  out.state.end = function end(this: typeof out.state, body?: unknown) { if (typeof body === 'string') file = body; return this; };
  await (easyfile as Route)(req as never, out.res as never);
  expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
  return file.split(/\r\n/).filter(l => /^400[136],/.test(l));
}

let recorded: { f: SeveranceFixture; runs: string[] };
let legacy: { f: SeveranceFixture; runs: string[] };

beforeAll(async () => {
  recorded = await seed('P4c recorded lines');
  legacy = await seed('P4c pre-948 lines');
  // As the calculator before 4c stored them: no retirement columns, no marks, and the taxable-flagged RA
  // (R1 000) already off periodic_taxable and taxable_income.
  await pool.query(
    `UPDATE payroll_run_lines SET retirement_contributions = NULL, retirement_deduction = NULL,
            periodic_taxable = periodic_taxable - 1000, taxable_income = taxable_income - 1000,
            component_breakdown = (SELECT jsonb_agg(item - 'retirementContribution') FROM jsonb_array_elements(component_breakdown) item)
      WHERE run_id = ANY($1)`, [legacy.runs]);
});
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

describe('pre-948 lines in the year to date', () => {
  it('May\'s year to date reads the same contributions and remuneration from either kind of line', async () => {
    const ytd = async (f: SeveranceFixture) => (await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 5 }, [f.employee])).get(f.employee)!;
    const a = await ytd(recorded.f);
    const b = await ytd(legacy.f);
    expect(a).toMatchObject({ periodicTaxable: 60_000, retirementContributions: 8_000, retirementDeduction: 8_000 });
    // The legacy lines recorded only the RA the old calculator deducted (2 × 1 000): the record differs, the tax does not.
    expect({ ...b, retirementDeduction: 0 }).toEqual({ ...a, retirementDeduction: 0 });
    expect(b.retirementDeduction).toBe(2_000);
  });

  it('May\'s PAYE is the same, and so is the certificate (4001 9 000, 4006 3 000)', async () => {
    const paye = async (f: SeveranceFixture) => {
      const id = await pay(f, 5);
      return (await pool.query<{ paye: number }>('SELECT paye::float8 AS paye FROM payroll_run_lines WHERE run_id = $1', [id])).rows[0]!.paye;
    };
    // 26 000 a month taxed: 312 000 → 44 118 + 26% × 66 900 = 61 512 − 17 820 = 43 692 ÷ 12 = 3 641.
    expect(await paye(recorded.f)).toBe(3_641);
    expect(await paye(legacy.f)).toBe(3_641);
    expect(await retirementCodes(legacy.f)).toEqual(['4001,9000', '4006,3000']);
    expect(await retirementCodes(recorded.f)).toEqual(['4001,9000', '4006,3000']);
  });
});
