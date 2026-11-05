/**
 * SDL year to date on real Postgres (payrollRunLineWriter, payrollYearToDate, payrollSdlYearToDate; SDL Act s3(4);
 * SARS SDL-GEN-01-G01 Rev 5 s6 and s4(b); migration 957).
 *
 * 1. The real writer and loader: runs calculated by calculatePayrollRun (the only writer of payroll_run_lines) store
 *    each line's SDL-applicable pay, leviable amount and whether the run was SDL-exempt (the s4(b) threshold on the
 *    employer's twelve-month remuneration); the next month reads them back and levies only the liable months.
 * 2. A line from before migration 957 (the columns NULL): read as it was costed: pay rebuilt from its breakdown
 *    (flagged items, else today's catalogue), exempt when it stored a nil levy that its pay would have carried,
 *    leviable amount = that pay, and none of its deduction (no credit).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
const companies: string[] = [];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-15T12:00:00+02:00'));
});

afterAll(async () => {
  vi.useRealTimers();
  try {
    for (const company of companies) {
      await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id=$1)', [company]);
      await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id=$1)', [company]);
      await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    }
  } finally {
    await cleanSeveranceFixtures(pool, fixtures).finally(() => pool.end());
  }
});

async function component(company: string, name: string, code: string, type: 'earning' | 'deduction', sdl: boolean): Promise<string> {
  return String((await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_sdl_applicable)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [company, name, code, type, sdl])).rows[0]!.id);
}

interface Month { month: number; salary: number; ra: number }
interface StoredLine { sdl: number; sdlApplicable: number; sdlLeviable: number; sdlExempt: boolean; retirementDeduction: number }

/** An employer paying one employee by month (2026, tax year 2027), each run calculated by the real writer then approved. */
async function payYear(name: string, months: Month[]): Promise<StoredLine[]> {
  const company = crypto.randomUUID();
  companies.push(company);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, name]);
  const salary = await component(company, 'Basic salary', '3601', 'earning', true);
  const retirement = await component(company, 'Retirement annuity', '4006', 'deduction', false);
  const employee = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,date_of_birth,status,
       medical_aid_main_member,medical_aid_dependants_count)
     VALUES($1,$2,'SDL-1','Sdl','Year','2020-01-01','1980-06-15','active',false,0)`, [employee, company]);
  const lines: StoredLine[] = [];
  for (const m of months) {
    const from = `2026-${String(m.month).padStart(2, '0')}-01`;
    const to = `2026-${String(m.month).padStart(2, '0')}-28`;
    for (const [comp, amount] of [[salary, m.salary], [retirement, m.ra]] as const) {
      if (amount === 0) continue;
      await pool.query(
        `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
         VALUES($1,$2,$3,$4::date,$5::date,false)`, [employee, comp, amount, from, to]);
    }
    const run = crypto.randomUUID();
    await pool.query(
      `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'draft')`,
      [run, company, m.month]);
    await calculatePayrollRun(run, company);
    await pool.query(`UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1`, [run]);
    const row = (await pool.query(
      `SELECT sdl::float8 AS sdl, sdl_applicable::float8 AS "sdlApplicable", sdl_leviable::float8 AS "sdlLeviable",
              sdl_exempt AS "sdlExempt", retirement_deduction::float8 AS "retirementDeduction"
         FROM payroll_run_lines WHERE run_id = $1`, [run])).rows[0] as StoredLine;
    lines.push(row);
  }
  return lines;
}

describe('the real writer and loader across exempt and liable months (migration 957)', () => {
  it('REPRO 8: exempt month then liable month with the contribution reversed: the liable month is levied on its whole pay', async () => {
    // March R10 000 -> twelve-month estimate R120 000: exempt. April R90 000 -> (10 + 90) / 2 x 12 = R600 000: liable.
    // March's RA R2 500 (under 27.5% of R10 000) is reversed in April (PAYE records -R2 500); the liable pay is R90 000 with no deduction standing.
    const lines = await payYear('SDL repro 8', [{ month: 3, salary: 10_000, ra: 2_500 }, { month: 4, salary: 90_000, ra: -2_500 }]);
    expect(lines.map(l => l.sdlExempt)).toEqual([true, false]);
    expect(lines.map(l => l.sdlApplicable)).toEqual([10_000, 90_000]);
    expect(lines.map(l => l.retirementDeduction)).toEqual([2_500, -2_500]);
    expect(lines.map(l => l.sdl)).toEqual([0, 900]);
    expect(lines[1]!.sdlLeviable).toBe(90_000);
  });

  it('liable, exempt, liable: the exempt month\'s pay and deduction stay out; the liable months carry R117 000', async () => {
    // March R60 000, RA R3 000: estimate R720 000, liable. April R10 000, RA R3 000: (60 + 10) / 2 x 12 = R420 000, exempt.
    // May R60 000: (60 + 10 + 60) / 3 x 12 = R520 000, liable. Liable pay R120 000, liable deduction R3 000.
    const lines = await payYear('SDL liable exempt liable', [
      { month: 3, salary: 60_000, ra: 3_000 }, { month: 4, salary: 10_000, ra: 3_000 }, { month: 5, salary: 60_000, ra: 0 },
    ]);
    expect(lines.map(l => l.sdlExempt)).toEqual([false, true, false]);
    expect(lines.map(l => l.sdl)).toEqual([570, 0, 600]);
    expect(lines.filter(l => !l.sdlExempt).reduce((t, l) => t + l.sdlLeviable, 0)).toBe(117_000);
  });

  it('the loader hands the next month only the liable lines\' figures', async () => {
    const company = companies[companies.length - 1]!;
    const employee = String((await pool.query('SELECT id FROM payroll_employees WHERE company_id = $1', [company])).rows[0]!.id);
    const ytd = (await loadPayeYearToDate(company, crypto.randomUUID(), { year: 2026, month: 6 }, [employee])).get(employee)!;
    expect(ytd).toMatchObject({ sdlApplicable: 120_000, sdlLeviable: 117_000, sdlRetirementDeduction: 3_000 });
  });
});

describe('lines from before migration 957 (the columns NULL)', () => {
  it('are read as costed: rebuilt pay, exempt when a nil levy was due, leviable amount = pay; stored lines as stored', async () => {
    const f = await seedEmployee(pool, fixtures, 'P4c SDL legacy lines', 20_000);
    const sdlEarning = await component(f.company, 'Catalogue SDL earning', '3601', 'earning', true);
    const plainEarning = await component(f.company, 'Catalogue non-SDL earning', '3713', 'earning', false);
    const deduction = await component(f.company, 'Union dues', '4018', 'deduction', true);
    const item = (componentId: string, code: string, amount: number, extra: Record<string, unknown> = {}) => ({
      componentId, componentName: code, sarsSourceCode: code, amount, isTaxable: true, isUifApplicable: false, ...extra });
    const line = async (month: number, status: string, cols: Record<string, unknown>, breakdown: unknown[]): Promise<void> => {
      const run = (await pool.query(
        `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status) VALUES ($1, 2026, $2, $3) RETURNING id`,
        [f.company, month, status])).rows[0]!.id;
      await pool.query(
        `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, periodic_taxable, annual_taxable, paye, net_pay,
                                        retirement_contributions, retirement_deduction, sdl, sdl_applicable, sdl_leviable, sdl_exempt,
                                        component_breakdown)
         VALUES ($1, $2, 30000, 20000, 20000, 0, 0, 30000, $3, $3, $4, $5, $6, $7, $8)`,
        [run, f.employee, cols.ded, cols.sdl, cols.pay ?? null, cols.leviable ?? null, cols.exempt ?? null, JSON.stringify(breakdown)]);
    };
    // March: before 957, flagged items: pay R20 000 (the R3 000 item is flagged out), levied R200, RA R5 000 recorded.
    await line(3, 'approved', { ded: 5_000, sdl: 200 }, [
      item('s', '3601', 20_000, { isSdlApplicable: true }), item('b', '3601', 3_000, { isSdlApplicable: false }),
    ]);
    // April: before 957 and before the flag: catalogue pay R10 000 (R4 000 not SDL, a deduction and a deleted component
    // count nothing), nil levy that R10 000 would have carried: an exempt month.
    await line(4, 'approved', { ded: 2_000, sdl: 0 }, [
      item(sdlEarning, '3601', 10_000), item(plainEarning, '3713', 4_000), item(deduction, '4018', 500), item(crypto.randomUUID(), '3601', 999),
    ]);
    // May: written by 957's writer: stored pay R8 000, leviable R7 000, liable, RA R1 000.
    await line(5, 'approved', { ded: 1_000, sdl: 70, pay: 8_000, leviable: 7_000, exempt: false }, [item('s', '3601', 8_000, { isSdlApplicable: true })]);
    // June: only calculated: never in it.
    await line(6, 'calculated', { ded: 0, sdl: 50, pay: 50_000, leviable: 50_000, exempt: false }, [item('s', '3601', 50_000, { isSdlApplicable: true })]);

    const ytd = (await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 7 }, [f.employee])).get(f.employee)!;
    // Liable: March (legacy: pay 20 000, leviable 20 000 = its pay, NO deduction: no credit for its R5 000) and May
    // (stored: 8 000, 7 000, RA 1 000).
    expect(ytd).toMatchObject({ sdlApplicable: 28_000, sdlLeviable: 27_000, sdlRetirementDeduction: 1_000 });
    // The PAYE figures read the same lines: all three approved months' deductions.
    expect(ytd.retirementDeduction).toBe(8_000);
  });
});
