/**
 * Donations (4030) on real Postgres: the real writer and loader (calculatePayrollRun, payrollRunLineWriter,
 * loadPayeYearToDate) under SARS PAYE-GEN-01-G21 (2027) "Donations" (migration 959).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { payrollTermsChangedSinceCalculation } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { getPayrollEmployee, updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { loadRetirementContributions } from '@/modules/accounting/services/payroll/payrollRetirementRecord';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-15T12:00:00+02:00'));
});
afterAll(async () => {
  vi.useRealTimers();
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

async function donate(f: SeveranceFixture, month: number, amount: number): Promise<void> {
  const id = String((await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
     VALUES ($1, $2, '4030', 'deduction', true) RETURNING id`, [f.company, `Donation ${month}`])).rows[0]!.id);
  const day = `2026-${String(month).padStart(2, '0')}`;
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
     VALUES ($1, $2, $3, $4::date, $5::date, false)`, [f.employee, id, amount, `${day}-01`, `${day}-28`]);
}

async function run(f: SeveranceFixture, month: number) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_run_headers (id, company_id, period_month, period_year, status) VALUES ($1, $2, $3, 2026, 'draft')`,
    [id, f.company, month]);
  await calculatePayrollRun(id, f.company);
  await pool.query(`UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1`, [id]);
  return (await pool.query(
    `SELECT taxable_income::float8 AS taxable, sdl_leviable::float8 AS leviable, donation_receipted::float8 AS receipted,
            donation_base::float8 AS base, donation_deduction::float8 AS deduction, validation_results AS warnings
       FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2`, [id, f.employee])).rows[0] as {
    taxable: number; leviable: number; receipted: number; base: number; deduction: number; warnings: { code: string }[];
  };
}

describe('the receipt flag', () => {
  it('defaults off, and a save stores it', async () => {
    const f = await seedEmployee(pool, fixtures, 's18a flag', 20_000);
    expect((await getPayrollEmployee(f.employee, f.company))?.s18aReceiptHeld).toBe(false);
    await updatePayrollEmployee(f.employee, f.company, { s18aReceiptHeld: true });
    expect((await getPayrollEmployee(f.employee, f.company))?.s18aReceiptHeld).toBe(true);
    // A save that does not mention it leaves it alone.
    await updatePayrollEmployee(f.employee, f.company, { firstName: 'Renamed' });
    expect((await getPayrollEmployee(f.employee, f.company))?.s18aReceiptHeld).toBe(true);
  });
});

describe('the approval gate', () => {
  it.each([[true, false], [false, true]])('a tick moved from %j to %j after calculation sends the run back', async (from, to) => {
    const f = await seedEmployee(pool, fixtures, `s18a gate ${from}`, 20_000);
    await updatePayrollEmployee(f.employee, f.company, { s18aReceiptHeld: from });
    await donate(f, 3, 500);
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO payroll_run_headers (id, company_id, period_month, period_year, status) VALUES ($1, $2, 3, 2026, 'draft')`,
      [id, f.company]);
    await calculatePayrollRun(id, f.company);
    expect(await payrollTermsChangedSinceCalculation(f.company, id, [f.employee])).toEqual([]);
    await updatePayrollEmployee(f.employee, f.company, { s18aReceiptHeld: to });
    expect(await payrollTermsChangedSinceCalculation(f.company, id, [f.employee])).toEqual([f.employee]);
  });
});

describe('stored lines and the year to date (migration 959)', () => {
  it('no receipt: nothing deducted, warned', async () => {
    const f = await seedEmployee(pool, fixtures, 's18a no receipt', 20_000);
    await donate(f, 3, 500);
    const line = await run(f, 3);
    expect([line.receipted, line.deduction, line.taxable, line.leviable]).toEqual([0, 0, 20_000, 20_000]);
    expect(line.warnings.map(w => w.code)).toContain('DONATION_WITHOUT_S18A_RECEIPT');
  });

  it('a reversal of a no-receipt donation takes nothing back', async () => {
    const f = await seedEmployee(pool, fixtures, 's18a no receipt reversal', 20_000);
    await donate(f, 3, 500);
    await run(f, 3);
    await donate(f, 4, -500);
    const april = await run(f, 4);
    expect([april.receipted, april.deduction, april.taxable, april.leviable]).toEqual([0, 0, 20_000, 20_000]);
  });

  it('with a receipt: capped in March, the excess comes off in April as the 5% grows, then none in May', async () => {
    const f = await seedEmployee(pool, fixtures, 's18a cumulative', 20_000);
    await updatePayrollEmployee(f.employee, f.company, { s18aReceiptHeld: true });
    await donate(f, 3, 2_000);
    const march = await run(f, 3);
    expect([march.receipted, march.base, march.deduction, march.taxable, march.leviable]).toEqual([2_000, 20_000, 1_000, 19_000, 19_000]);
    const april = await run(f, 4);
    expect([april.receipted, april.base, april.deduction, april.taxable, april.leviable]).toEqual([0, 20_000, 1_000, 19_000, 19_000]);
    const may = await run(f, 5);
    expect([may.deduction, may.taxable, may.leviable]).toEqual([0, 20_000, 20_000]);
  });

  it('a donation reversed from before migration 959 is read from its breakdown: PAYE takes it back, SDL does not', async () => {
    const f = await seedEmployee(pool, fixtures, 's18a legacy reversal', 20_000);
    await updatePayrollEmployee(f.employee, f.company, { s18aReceiptHeld: true });
    await donate(f, 3, 1_000);
    await run(f, 3);
    await pool.query(
      `UPDATE payroll_run_lines SET donation_receipted = NULL, donation_base = NULL, donation_deduction = NULL
        WHERE employee_id = $1`, [f.employee]);
    await donate(f, 4, -1_000);
    const april = await run(f, 4);
    expect([april.receipted, april.deduction, april.taxable, april.leviable]).toEqual([-1_000, -1_000, 21_000, 20_000]);
  });

  it('a line from before migration 959 (NULL) gives no credit and no clawback', async () => {
    const f = await seedEmployee(pool, fixtures, 's18a legacy', 20_000);
    await updatePayrollEmployee(f.employee, f.company, { s18aReceiptHeld: true });
    await donate(f, 3, 1_000);
    await run(f, 3);
    await pool.query(
      `UPDATE payroll_run_lines SET donation_receipted = NULL, donation_base = NULL, donation_deduction = NULL
        WHERE employee_id = $1`, [f.employee]);
    await donate(f, 4, 500);
    const april = await run(f, 4);
    expect([april.receipted, april.base, april.deduction]).toEqual([500, 20_000, 500]);
  });
});

describe('the certificate reports 4030 in full (BRS V25.3.0 p. 102; PAYE-GEN-01-G21 (2027) p. 11)', () => {
  const year = { start: '2026-03-01', end: '2027-02-01' };
  const donated = async (f: SeveranceFixture) => (await loadRetirementContributions(f.company, year, [f.employee])).get(f.employee)?.donations4030;

  it('the whole donation, also the part above the 5% and a non-taxable 4030, though PAYE allowed less', async () => {
    const f = await seedEmployee(pool, fixtures, 's18a certificate full', 20_000);
    await updatePayrollEmployee(f.employee, f.company, { s18aReceiptHeld: true });
    await donate(f, 3, 2_000);
    const untaxed = String((await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Donation untaxed', '4030', 'deduction', false) RETURNING id`, [f.company])).rows[0]!.id);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
       VALUES ($1, $2, 100, '2026-03-01', '2026-03-28', false)`, [f.employee, untaxed]);
    // Not a donation deducted from pay: a 4030 on an earning component, and a padded code that still counts.
    const earning = String((await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Mis-typed 4030 earning', '4030', 'earning', false) RETURNING id`, [f.company])).rows[0]!.id);
    const padded = String((await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Donation padded', E' 4030\\t', 'deduction', false) RETURNING id`, [f.company])).rows[0]!.id);
    for (const [component, amount] of [[earning, 300], [padded, 50]] as const) {
      await pool.query(
        `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
         VALUES ($1, $2, $3, '2026-03-01', '2026-03-28', false)`, [f.employee, component, amount]);
    }
    expect((await run(f, 3)).deduction).toBe(1_000);
    expect(await donated(f)).toBe(2_150);
  });

  it('without a receipt: nothing allowed, still reported; a reversal nets it out', async () => {
    const f = await seedEmployee(pool, fixtures, 's18a certificate no receipt', 20_000);
    await donate(f, 3, 500);
    expect((await run(f, 3)).deduction).toBe(0);
    expect(await donated(f)).toBe(500);
    await donate(f, 4, -500);
    await run(f, 4);
    expect(await donated(f)).toBe(0);
  });
});
