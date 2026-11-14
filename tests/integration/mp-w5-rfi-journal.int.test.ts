/**
 * Wave 5 RF round 1 (TDD M): the employer retirement contribution in the payroll journal, on real Postgres and real run lines.
 * Only NON-CASH 3817 / 3825 / 3828 items count (a pre-RF cash 3817 is already in gross), a padded code is trimmed, 3828 is in,
 * a claw-back nets, another company's run is empty; the plan books the net to 2175 (credit, or debit for a net claw-back) and balances.
 * Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runEmployerNonCash } from '../../src/modules/accounting/services/payroll/payrollJournalEmployerMedical';
import { buildPayrollJournalPlan } from '../../src/modules/accounting/services/payroll/payrollJournalBuilder';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, seedPayrollCompany } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const runs: Record<string, string> = {};
const emp: Record<string, string> = {};
const item = (code: string, amount: number, nonCash: boolean) => ({
  componentId: code, componentName: code, sarsSourceCode: code, amount, isTaxable: true, isUifApplicable: true, ...(nonCash ? { isNonCash: true } : {}),
});
type Items = ReturnType<typeof item>[];

async function run(key: string, month: number, gross: number, lines: Array<[string, number, Items]>): Promise<void> {
  runs[key] = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, total_gross, total_paye, total_uif, total_sdl, total_eti, total_net)
     VALUES ($1, $2, 2026, 'approved', $3, 0, 0, 0, 0, $3) RETURNING id`, [company, month, gross])).rows[0]!.id;
  for (const [n, g, items] of lines) {
    await pool.query(
      `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, net_pay, component_breakdown)
       VALUES ($1, $2, $3, $3, 0, 0, 0, 0, $3, $4::jsonb)`, [runs[key], emp[n], g, JSON.stringify(items)]);
  }
}

beforeAll(async () => {
  for (const c of [company, other]) await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [c, `RFJ ${c.slice(0, 8)}`]);
  await seedPayrollCompany(pool, company);
  await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
    VALUES ($1, '2175', 'Other Employee Deductions Payable', 'liability', 'credit', 1)`, [company]);
  for (const n of ['a', 'b', 'c', 'd']) {
    emp[n] = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date) VALUES ($1, $2, 'J', $2, '2020-01-01') RETURNING id`,
      [company, `RFJ-${n}`])).rows[0]!.id;
  }
  await run('march', 3, 40_000 + 2_000, [
    ['a', 10_000, [item('3601', 10_000, false), item('3817', 3_000, true), item('3810', 1_000, true)]],
    ['b', 10_000, [item('3601', 10_000, false), item('3825', 1_500, true), item(' 3828 ', 500, true)]],
    // A pre-RF 3817 kept as cash: in gross already, not booked again.
    ['c', 12_000, [item('3601', 10_000, false), item('3817', 2_000, false)]],
    ['d', 10_000, [item('3601', 10_000, false), item('3817', -800, true)]],
  ]);
  await run('claw', 4, 10_000, [['d', 10_000, [item('3601', 10_000, false), item('3817', -800, true)]]]);
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[company, other]]);
  } finally { await pool.end(); }
});

describe('runEmployerNonCash', () => {
  it('counts only non-cash 3817 / 3825 / 3828 (trimmed) as retirement and 3810 as medical, a claw-back negative', async () => {
    const { medical, retirement } = await runEmployerNonCash(company, runs.march!);
    expect(Object.fromEntries(retirement)).toEqual({ [emp.a!]: 3000, [emp.b!]: 2000, [emp.d!]: -800 });
    expect(Object.fromEntries(medical)).toEqual({ [emp.a!]: 1000 });
  });
  it('is scoped to the company', async () => {
    const r = await runEmployerNonCash(other, runs.march!);
    expect([r.medical.size, r.retirement.size]).toEqual([0, 0]);
  });
});

describe('the plan books it to 2175 and balances', () => {
  const on2175 = (plan: NonNullable<Awaited<ReturnType<typeof buildPayrollJournalPlan>>>, re: RegExp) =>
    plan.lines.filter((l) => l.accountCode === '2175' && re.test(l.description)).map((l) => [l.debit, l.credit]);
  it('March: one 2175 credit of the net 4 200 payable to the fund, labour carries it, debits = credits', async () => {
    const plan = (await buildPayrollJournalPlan(company, runs.march!))!;
    expect(on2175(plan, /retirement fund contributions \(/)).toEqual([[0, 4200]]);
    expect(plan.totals.employerRetirement).toBe(4200);
    expect(plan.lines.filter((l) => l.accountCode === '5200').reduce((s, l) => s + l.debit, 0)).toBe(42_000 + 1_000 + 4_200);
    expect(plan.totalDebit).toBe(plan.totalCredit);
  });
  it('April: a net claw-back is a 2175 debit, and the journal still balances', async () => {
    const plan = (await buildPayrollJournalPlan(company, runs.claw!))!;
    expect(on2175(plan, /retirement fund contributions reversal/)).toEqual([[800, 0]]);
    expect(plan.totalDebit).toBe(plan.totalCredit);
  });
});
