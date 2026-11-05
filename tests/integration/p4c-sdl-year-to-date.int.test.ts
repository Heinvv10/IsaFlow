/**
 * SDL year to date on real Postgres (payrollYearToDate, payrollSdlYearToDate; SDL Act s3(4); SARS SDL-GEN-01-G01
 * Rev 5 s6). payroll_run_lines stores no leviable amount, so the loader rebuilds it from each line's SDL-applicable
 * pay and retirement_deduction. SDL-applicable pay is the breakdown items flagged `isSdlApplicable` as costed; an
 * item from before the flag is read by today's catalogue (an earning flagged is_sdl_applicable).
 *
 * Employee with three lines (the stored levy `sdl` tells a levied line from an exempt one):
 *   March (new flags): salary 20 000 (SDL), bonus 3 000 (flag false), RA 5 000 deducted; retirement_deduction 5 000.
 *   April (pre-flag items): catalogue earning flagged SDL 10 000, catalogue earning not flagged 4 000, a deduction
 *     component (is_sdl_applicable defaults true) 500, an item whose component is gone 999; retirement_deduction 2 000.
 *   May: a CALCULATED run (not declarable): never in it.
 * To date at June: SDL pay 20 000 + 10 000 = 30 000; leviable max(15 000, 30 000 - 7 000 = 23 000) = 23 000.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

async function component(company: string, name: string, code: string, type: 'earning' | 'deduction', sdl: boolean): Promise<string> {
  return String((await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_sdl_applicable)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [company, name, code, type, sdl])).rows[0]!.id);
}

async function line(
  f: SeveranceFixture, month: number, status: string, retirementDeduction: number | null, breakdown: unknown[], sdl: number,
): Promise<void> {
  const run = (await pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status) VALUES ($1, 2026, $2, $3) RETURNING id`,
    [f.company, month, status])).rows[0]!.id;
  await pool.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, periodic_taxable, annual_taxable, paye, net_pay,
                                    retirement_contributions, retirement_deduction, component_breakdown, sdl)
     VALUES ($1, $2, 30000, 20000, 20000, 0, 0, 30000, $3, $3, $4, $5)`,
    [run, f.employee, retirementDeduction, JSON.stringify(breakdown), sdl]);
}

describe('SDL year to date (payrollSdlYearToDate)', () => {
  it('sums flagged items as costed and reads a pre-flag line by the catalogue, from the same lines as PAYE', async () => {
    const f = await seedEmployee(pool, fixtures, 'P4c SDL year to date', 20_000);
    const sdlEarning = await component(f.company, 'Catalogue SDL earning', '3601', 'earning', true);
    const plainEarning = await component(f.company, 'Catalogue non-SDL earning', '3713', 'earning', false);
    const deduction = await component(f.company, 'Union dues', '4018', 'deduction', true);
    const item = (componentId: string, code: string, amount: number, extra: Record<string, unknown> = {}) => ({
      componentId, componentName: code, sarsSourceCode: code, amount, isTaxable: true, isUifApplicable: false, ...extra });

    await line(f, 3, 'approved', 5_000, [
      item('s', '3601', 20_000, { isSdlApplicable: true }),
      item('b', '3601', 3_000, { isSdlApplicable: false }),
      item('r', '4006', 5_000, { isSdlApplicable: false, retirementContribution: true }),
    ], 150);
    await line(f, 4, 'approved', 2_000, [
      item(sdlEarning, '3601', 10_000),
      item(plainEarning, '3713', 4_000),
      item(deduction, '4018', 500),
      item(crypto.randomUUID(), '3601', 999),
    ], 80);
    await line(f, 5, 'calculated', 0, [item('s', '3601', 50_000, { isSdlApplicable: true })], 500);

    const june = (await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 6 }, [f.employee])).get(f.employee)!;
    expect(june.sdlApplicable).toBe(30_000);
    expect(june.sdlLeviable).toBe(23_000);
    // Only the declarable lines before the period are in it (the same set the PAYE figures use).
    expect(june.retirementDeduction).toBe(7_000);
    expect((await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 4 }, [f.employee])).get(f.employee))
      .toMatchObject({ sdlApplicable: 20_000, sdlLeviable: 15_000 });
  });

  it('reads the stored levy: an exempt month (nil levy) is left out of the levied pay and keeps the deduction it absorbed', async () => {
    const f = await seedEmployee(pool, fixtures, 'P4c SDL year to date exempt', 20_000);
    const item = (amount: number) => ({
      componentId: 's', componentName: '3601', sarsSourceCode: '3601', amount, isTaxable: true, isUifApplicable: false, isSdlApplicable: true });
    await line(f, 3, 'approved', 5_000, [item(20_000)], 0);
    await line(f, 4, 'approved', -5_000, [item(20_000)], 200);
    expect((await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 5 }, [f.employee])).get(f.employee))
      .toMatchObject({ sdlApplicable: 20_000, sdlLeviable: 20_000, sdlExemptDeduction: 0 });
  });
});
