/**
 * Wave 6 FQc on real Postgres, two tenants: four weekly runs in June 2026, calculated by the real writer
 * (calculatePayrollRun) one after another, each approved before the next.
 *
 *  - n and P: run k's year to date holds runs 1..k-1 (pay order, payrollRunOrder; spec F2);
 *  - once-offs keyed by run: a once-off dated in week 1 is paid by week 1 only, one in week 3 by week 3 only;
 *  - UIF on the month to date (UIC Act s6(1)(a); ceiling R17 712): R6 000 a week levies 60, 60, 57.12, 0;
 *  - ETI on the month's last run (SARS ETI guide s2.4): weeks 1-3 nil with ETI_MONTH_PENDING, week 4 on June's pay;
 *  - EMP201 for June sums the four runs; the other tenant's runs, interleaved, are never in it;
 *  - the refusals: a loan on a weekly employee, a run outside its pay date's month, a mid-year frequency change;
 *  - PAYE_LATER_PERIODS_APPROVED names the later RUN, and the gate clears on it (review #1507 B2b);
 *  - the reversal guard finds an unlinked weekly or off-cycle journal's run by its run-keyed description.
 *
 * FQx (migration 999p) drops payroll_run_headers' per-month unique; FQc merges first, so each case drops it inside its
 * own transaction and rolls everything back (w6-fqb1.helpers twoRunsInMonth): no other suite sees it gone.
 * The run-kind guard (FQa) still refuses weekly runs until FQd lifts its frequency clause, so it is stubbed here; its
 * own suites are payrollRunKindGuard*.test.ts. payrollFrequencyGuard (FQc's refusals) runs for real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropTenants, seedTenant, twoRunsInMonth, type Tenant } from './w6-fqb1.helpers';

vi.mock('@/modules/accounting/services/payroll/payrollRunKindGuard', async (orig) => ({
  ...await orig<typeof import('@/modules/accounting/services/payroll/payrollRunKindGuard')>(),
  assertRunKindSupported: vi.fn(async () => undefined),
}));

import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { judgeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDateGate';
import { refuseReversalAgainstPayRun } from '@/modules/accounting/services/payroll/payrollJournalReversalGuard';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { createLoan } from '@/modules/accounting/services/payroll/payrollLoanService';
import { computeAnnualTax, getTaxYearConfig } from '@/modules/accounting/services/payroll/taxTables';
import { runJournalDescriptionOf } from '@/modules/accounting/services/payroll/payrollJournalDescription';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let A: Tenant;
let B: Tenant;
/** The case's transaction-bound client (twoRunsInMonth): every raw write goes on it, so the rollback takes it away. */
let c: PoolClient;

/** June 2026's four weeks, Saturday to Friday, paid on the Friday (period_end: no app code writes run_date). */
const WEEKS = [['2026-05-30', '2026-06-05'], ['2026-06-06', '2026-06-12'], ['2026-06-13', '2026-06-19'], ['2026-06-20', '2026-06-26']] as const;

interface People { young: string; big: string; salary: string; extra: string }

/** A weekly company: GL accounts, Basic Salary (3601) and a once-off 3602, a young ETI employee and an R6 000 a week one. */
async function seedWeekly(c: PoolClient, t: Tenant): Promise<People> {
  for (const [code, type] of [['5200', 'expense'], ['1110', 'asset'], ['2140', 'liability'], ['2150', 'liability'], ['2160', 'liability'], ['2175', 'liability']] as const) {
    await c.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7) ON CONFLICT DO NOTHING`,
      [t.company, code, `FQc ${code}`, type, type === 'liability' ? 'credit' : 'debit', code === '1110' ? 'bank' : null, code === '1110']);
  }
  const comp = async (name: string, code: string) => String((await c.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type) VALUES ($1, $2, $3, 'earning') RETURNING id`,
    [t.company, name, code])).rows[0].id);
  const salary = await comp('Basic Salary', '3601');
  const extra = await comp('Overtime', '3602');
  const employee = async (num: string, born: string, start: string, idNumber: string | null, weekly: number) => {
    const id = String((await c.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number,
         id_number, hours_per_week, medical_aid_main_member, pay_frequency)
       VALUES ($1, $2, 'Wanda', $2, $3::date, $4::date, '0123456789', $5, 40, false, 'weekly') RETURNING id`,
      [t.company, num, start, born, idNumber])).rows[0].id);
    await c.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, $4::date)`,
      [id, salary, weekly, start]);
    return id;
  };
  // A valid SA ID matching the date of birth (ETI Act s6(b)); 24 in June 2026, employed since September 2025.
  const young = await employee('FQC-YOUNG', '2002-05-20', '2025-09-01', '0205205009082', 1500);
  const big = await employee('FQC-BIG', '1980-01-01', '2020-01-01', null, 6000);
  return { young, big, salary, extra };
}

async function weeklyRun(c: PoolClient, t: Tenant, [start, end]: readonly [string, string], month = 6): Promise<string> {
  return String((await c.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, pay_frequency, period_start, period_end)
     VALUES ($1, $2, 2026, 'draft', 'weekly', $3::date, $4::date) RETURNING id`, [t.company, month, start, end])).rows[0].id);
}

async function approve(c: PoolClient, runId: string): Promise<void> {
  // As approvePayrollRun leaves it: approved with its approval time (the year to date reads final runs).
  await c.query(`UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1`, [runId]);
}

interface Line { gross: number; paye: number; uif: number; eti: number; codes: string[] }
async function line(c: PoolClient, runId: string, employee: string): Promise<Line> {
  const r = (await c.query(
    `SELECT gross_pay::float8 AS gross, paye::float8 AS paye, uif_employee::float8 AS uif, eti::float8 AS eti,
            ARRAY(SELECT v->>'code' FROM jsonb_array_elements(validation_results) v) AS codes
       FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2`, [runId, employee])).rows[0];
  return r as Line;
}

beforeAll(async () => {
  A = await seedTenant(pool, 'W6 FQc A');
  B = await seedTenant(pool, 'W6 FQc B');
});

afterAll(async () => {
  try { await dropTenants(pool, [A, B]); } finally { await pool.end(); }
});

describe('four weekly runs in June, two tenants interleaved', () => {
  it('n and P by run, once-offs paid once, UIF on the month to date, ETI on the last run, EMP201 sums the four', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      await seedWeekly(c, B);
      // A's once-offs: R200 in week 1, R300 in week 3 (each its own run's, spec F2).
      await c.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
                     VALUES ($1, $2, 200, '2026-06-03', '2026-06-03', false), ($1, $2, 300, '2026-06-17', '2026-06-17', false)`, [a.young, a.extra]);
      const runs: string[] = [];
      const ytd: Array<{ periods: number; periodicTaxable: number } | undefined> = [];
      for (const week of WEEKS) {
        const other = await weeklyRun(c, B, week); // B's run of the week first: never in A's figures
        await calculatePayrollRun(other, B.company);
        await approve(c, other);
        const id = await weeklyRun(c, A, week);
        const y = (await loadPayeYearToDate(A.company, id, { year: 2026, month: 6 }, [a.young])).get(a.young);
        ytd.push(y && { periods: y.periods, periodicTaxable: y.periodicTaxable });
        await calculatePayrollRun(id, A.company);
        await approve(c, id);
        runs.push(id);
      }
      const young = await Promise.all(runs.map((r) => line(c, r, a.young)));
      const big = await Promise.all(runs.map((r) => line(c, r, a.big)));
      const emp201 = await generateEMP201(A.company, '2026-06-01', '2026-06-30');
      const headers = (await c.query(`SELECT COALESCE(SUM(total_paye), 0)::float8 AS paye, COALESCE(SUM(total_eti), 0)::float8 AS eti
                                         FROM payroll_run_headers WHERE id = ANY($1)`, [runs])).rows[0];
      return { ytd, young, big, emp201, headers };
    });

    // Runs 2-4 see runs 1-3 in n and P (A's only: B's young employee earns the same and is never counted).
    expect(got.ytd).toEqual([undefined, { periods: 1, periodicTaxable: 1700 }, { periods: 2, periodicTaxable: 3200 }, { periods: 3, periodicTaxable: 5000 }]);
    // Each once-off is paid by its own week's run, once.
    expect(got.young.map((l) => l.gross)).toEqual([1700, 1500, 1800, 1500]);
    // UIF: 1% of the room under R17 712 after the month's earlier weeks.
    expect(getTaxYearConfig(2027).uifCeiling).toBe(17712);
    expect(got.big.map((l) => l.uif)).toEqual([60, 60, 57.12, 0]);
    // PAYE x 52 over the weeks worked: four equal weeks of a constant R6 000 total four 52nds of the year's tax.
    const config = getTaxYearConfig(2027);
    const yearTax = computeAnnualTax(6000 * 52, config.brackets) - config.primaryRebate;
    expect(got.big.reduce((t, l) => t + l.paye, 0)).toBeCloseTo((yearTax * 4) / 52, 1);
    // ETI: nil and pending on weeks 1-3, claimed on week 4 on June's R6 500.
    expect(got.young.slice(0, 3).map((l) => [l.eti, l.codes.includes('ETI_MONTH_PENDING')])).toEqual([[0, true], [0, true], [0, true]]);
    expect(got.young[3]!.codes).not.toContain('ETI_MONTH_PENDING');
    // June's R6 500 (1 700 + 1 500 + 1 800 + 1 500), month 10 of employment, 40 h a week (173.33 h, no gross-up): the April 2025
    // table's taper, R1 500 - 75% x (6 500 - 5 500) = R750 (etiTables.ts). A week's R1 500 alone would have claimed 60% = R900.
    expect(got.young[3]!.eti).toBe(750);
    // EMP201: the four runs, their PAYE and ETI, and nothing of B's.
    expect(got.emp201.payrollRuns).toHaveLength(4);
    expect(got.emp201.totalPAYE).toBeCloseTo(got.headers.paye, 2);
    expect(got.emp201.totalETI).toBeCloseTo(got.headers.eti, 2);
    expect(got.emp201.totalETI).toBe(got.young[3]!.eti);
  });
});

describe('what a weekly run refuses this wave (payrollFrequencyGuard)', () => {
  it('a loan on a weekly employee: refused where it is created, and at calculate, before any line is written', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      const created = await createLoan({
        companyId: A.company, employeeId: a.big, description: 'Advance', principal: 1000, annualInterestRate: 0, termMonths: 2,
        method: 'interest_free', startDate: '2026-06-01', firstDeductionPeriod: { year: 2026, month: 6 }, createdBy: A.user,
      } as never).then(() => null, (e: unknown) => e as { code?: string; status?: number });
      await c.query(`INSERT INTO payroll_loans (company_id, employee_id, loan_number, description, principal, term_months, method, start_date,
                       first_deduction_period_year, first_deduction_period_month, outstanding_balance)
                     VALUES ($1, $2, 'L1', 'Advance', 1000, 2, 'interest_free', '2026-06-01', 2026, 6, 1000)`, [A.company, a.big]);
      const run = await weeklyRun(c, A, WEEKS[0]);
      const calc = await calculatePayrollRun(run, A.company).then(() => null, (e: unknown) => e as { code?: string; status?: number; message: string });
      const lines = Number((await c.query('SELECT COUNT(*) FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0].count);
      return { created, calc, lines };
    });
    expect(got.created).toMatchObject({ code: 'PAY_FREQUENCY_REFUSED', status: 400 });
    expect(got.calc).toMatchObject({ code: 'PAY_FREQUENCY_REFUSED', status: 400 });
    expect(got.calc?.message).toContain('FQC-BIG');
    expect(got.lines).toBe(0);
  });

  it('a run whose pay date is not in its EMP201 month is refused (409)', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      await seedWeekly(c, A);
      const run = await weeklyRun(c, A, ['2026-06-27', '2026-07-03'], 6); // paid 3 July, filed as June
      return calculatePayrollRun(run, A.company).then(() => null, (e: unknown) => e as { code?: string; status?: number });
    });
    expect(got).toMatchObject({ code: 'PAY_FREQUENCY_REFUSED', status: 409 });
  });

  it('an employee paid monthly earlier in the tax year is refused on a weekly run (409); another tenant\'s monthly line is not', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      await seedWeekly(c, B);
      const may = async (t: Tenant, employee: string) => {
        const id = String((await c.query(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, approved_at)
                                           VALUES ($1, 5, 2026, 'approved', now()) RETURNING id`, [t.company])).rows[0].id);
        await c.query(`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, net_pay) VALUES ($1, $2, 1, 1, 0, 1)`, [id, employee]);
      };
      await may(A, a.big); // A's employee only: B's same-numbered employee was never paid monthly
      const refused = await calculatePayrollRun(await weeklyRun(c, A, WEEKS[0]), A.company).then(() => null, (e: unknown) => e as { code?: string; status?: number; message: string });
      const other = await calculatePayrollRun(await weeklyRun(c, B, WEEKS[0]), B.company).then(() => 'ok', (e: unknown) => e);
      return { refused, other };
    });
    expect(got.refused).toMatchObject({ code: 'PAY_FREQUENCY_REFUSED', status: 409 });
    expect(got.refused?.message).toContain('FQC-BIG');
    expect(got.other).toBe('ok');
  });
});

describe('the later-runs warning names runs, and the gate clears on them (review #1507 B2b)', () => {
  it('week 2 recalculated after week 3 was approved: the warning names week 3\'s run, and approving week 2 is not refused for it', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      const a = await seedWeekly(c, A);
      const ids: string[] = [];
      for (const week of WEEKS.slice(0, 3)) {
        const id = await weeklyRun(c, A, week);
        await calculatePayrollRun(id, A.company);
        await approve(c, id);
        ids.push(id);
      }
      // Week 2 reopened and recalculated while week 3 stays approved.
      await c.query(`UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL WHERE id = $1`, [ids[1]]);
      const before = (await judgeYearToDate(A.company, ids[1]!)).blocker?.code ?? null;
      await calculatePayrollRun(ids[1]!, A.company);
      const warning = (await c.query(
        `SELECT v FROM payroll_run_lines l, jsonb_array_elements(l.validation_results) v
          WHERE l.run_id = $1 AND l.employee_id = $2 AND v->>'code' = 'PAYE_LATER_PERIODS_APPROVED'`, [ids[1], a.big])).rows[0]?.v;
      const after = (await judgeYearToDate(A.company, ids[1]!)).blocker?.code ?? null;
      return { ids, before, warning, after };
    });
    expect(got.before).toBe('paye_year_to_date_stale');
    expect(got.warning?.runs).toEqual([got.ids[2]]);
    expect(got.warning?.periods).toEqual(['2026-06-13']);
    expect(got.after).toBeNull();
  });
});

describe('the reversal guard reads a run-keyed journal description', () => {
  it('an unlinked "Payroll run 2026-06 weekly, paid 2026-06-12" journal belongs to that week\'s run, not another week or tenant', async () => {
    const got = await twoRunsInMonth(pool, A, async (cl) => { c = cl; }, async () => {
      await seedWeekly(c, A);
      await seedWeekly(c, B);
      const ids: Record<string, string> = {};
      for (const [t, k] of [[B, 'b'], [A, 'a']] as const) {
        for (const [i, week] of WEEKS.entries()) ids[`${k}${i}`] = await weeklyRun(c, t, week);
      }
      const bonus = String((await c.query(
        `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, run_kind, off_cycle_reason, run_date, approved_at,
           period_start, period_end)
         VALUES ($1, 6, 2026, 'approved', 'off_cycle', 'bonus', '2026-06-28', now(), '2026-06-01', '2026-06-30') RETURNING *`, [A.company])).rows[0].id);
      const header = (id: string) => c.query('SELECT * FROM payroll_run_headers WHERE id = $1', [id]).then((r) => r.rows[0]);
      const journal = async (description: string) => String((await c.query(
        `INSERT INTO gl_journal_entries (company_id, entry_date, created_by, status, source, description, reference)
         VALUES ($1, '2026-06-30', $2, 'posted', 'auto_payroll', $3, 'PAY-2026-06') RETURNING id`, [A.company, A.user, description])).rows[0].id);
      const weekDescription = runJournalDescriptionOf(await header(ids.a1!));
      const bonusDescription = runJournalDescriptionOf(await header(bonus));
      const week = await refuseReversalAgainstPayRun(A.company, { id: await journal(weekDescription), source: 'auto_payroll' });
      const off = await refuseReversalAgainstPayRun(A.company, { id: await journal(bonusDescription), source: 'auto_payroll' });
      return { ids, bonus, weekDescription, bonusDescription, week: week?.runId, off: off?.runId };
    });
    expect([got.weekDescription, got.bonusDescription]).toEqual(['Payroll run 2026-06 weekly, paid 2026-06-12', 'Payroll run 2026-06 bonus, paid 2026-06-28']);
    expect(got.week).toBe(got.ids.a1);
    expect(got.off).toBe(got.bonus);
  });
});
