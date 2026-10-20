/**
 * Audit 2026-10-18 P3, review round 1: the edges of severance paid by SARS
 * directive — the directive's dates, a fixed-amount directive, two directives
 * for one leaver, a directive edited after calculation, a lump sum with no
 * directive, the severance-only line's ETI and loans, and a claim released when
 * a reopened run is approved again without the line. Real routes (withAuth,
 * app_user, RLS); disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import type { Route } from './w3-01-payroll.helpers';
import { updateTaxDirectiveStatus } from '@/modules/accounting/services/payroll/taxDirectiveService';
import {
  approvedDirective, approveRun, calculateRun, cleanSeveranceFixtures, codes, createRunFor, directivePayments,
  previewRun, reopenRun, runLine, seedRetrenchedEmployee, SALARY_PAYE, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
const seed = async (endDate: string, name: string) => {
  const f = await seedRetrenchedEmployee(pool, endDate, name);
  fixtures.push(f);
  return f;
};
const breakdownCodes = (l: { component_breakdown: unknown }) =>
  (l.component_breakdown as Array<{ sarsSourceCode: string }>).map(c => c.sarsSourceCode);

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_loans WHERE company_id = ANY($1)', [fixtures.map(f => f.company)]);
    await cleanSeveranceFixtures(pool, fixtures);
  } finally { await pool.end(); }
});

describe('P3: the directive must be in force on the last day of the run period', () => {
  it('expiring before it: not paid; expiring on it: paid', async () => {
    const early = await seed('2026-06-30', 'P3 expiry before period end');
    const d1 = await approvedDirective(early, 10_000, 0.1, '2026-06-01');
    await pool.query("UPDATE tax_directives SET expiry_date = '2026-06-29' WHERE id = $1", [d1]);
    const june1 = await createRunFor(early, 6);
    await calculateRun(early, june1);
    const l1 = await runLine(pool, june1, early.employee);
    expect(l1.gross).toBe(20_000);
    expect(codes(l1.validation_results)).toContain('SEVERANCE_AWAITING_DIRECTIVE');

    const onDay = await seed('2026-06-30', 'P3 expiry on period end');
    const d2 = await approvedDirective(onDay, 10_000, 0.1, '2026-06-01');
    await pool.query("UPDATE tax_directives SET expiry_date = '2026-06-30' WHERE id = $1", [d2]);
    const june2 = await createRunFor(onDay, 6);
    await calculateRun(onDay, june2);
    expect((await runLine(pool, june2, onDay.employee)).gross).toBe(30_000);
  });

  it('effective after the period: paid by the first run it is in force for, alone', async () => {
    const f = await seed('2026-06-30', 'P3 effective after period');
    await approvedDirective(f, 10_000, 0.1, '2026-07-05');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await runLine(pool, june, f.employee)).gross).toBe(20_000);
    expect((await approveRun(f, june)).statusCode).toBe(200);
    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    expect(await runLine(pool, july, f.employee)).toMatchObject({ gross: 10_000, paye: 1_000 });
  });
});

describe('P3: directive figures', () => {
  it('a fixed tax amount with no rate is paid as it stands', async () => {
    const f = await seed('2026-06-30', 'P3 fixed-amount directive');
    const d = await approvedDirective(f, 10_000, 0.1, '2026-06-01');
    // No product path writes this shape today (createTaxDirective derives the amount from the
    // rate); it is the legacy / imported form the stand-alone payment has always accepted.
    await pool.query('UPDATE tax_directives SET tax_rate = NULL, tax_amount = 1234.56 WHERE id = $1', [d]);
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await runLine(pool, june, f.employee)).paye).toBeCloseTo(SALARY_PAYE + 1234.56, 2);
    expect((await approveRun(f, june)).statusCode).toBe(200);
    expect((await directivePayments(pool, d))[0]).toMatchObject({ gross: 10_000, paye: 1234.56, net: 8765.44 });
  });

  it('edited after calculation: the preview and approval refuse, nothing is claimed', async () => {
    const f = await seed('2026-06-30', 'P3 directive edited');
    const d = await approvedDirective(f, 10_000, 0.1, '2026-06-01');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    await pool.query('UPDATE tax_directives SET amount = 12000 WHERE id = $1', [d]);
    expect((await previewRun(f, june)).body.data?.blocker?.code).toBe('severance_directive_unavailable');
    const refused = await approveRun(f, june);
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error?.message).toMatch(/figures changed/);
    expect(await directivePayments(pool, d)).toEqual([]);
  });

  it('two directives for one leaver: the earliest first, the other in the next run, then none', async () => {
    const f = await seed('2026-06-30', 'P3 two directives');
    const later = await approvedDirective(f, 7_000, 0.1, '2026-06-10', '2222222222');
    const first = await approvedDirective(f, 5_000, 0.1, '2026-06-01', '1111111111');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await runLine(pool, june, f.employee)).gross).toBe(25_000);
    expect((await approveRun(f, june)).statusCode).toBe(200);
    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    expect((await runLine(pool, july, f.employee)).gross).toBe(7_000);
    expect((await approveRun(f, july)).statusCode).toBe(200);
    expect((await directivePayments(pool, first))[0]!.payroll_run_id).toBe(june);
    expect((await directivePayments(pool, later))[0]!.payroll_run_id).toBe(july);
    const aug = await createRunFor(f, 8);
    await calculateRun(f, aug);
    expect(await runLine(pool, aug, f.employee)).toBeUndefined();
  });
});

describe('P3: a lump sum without a directive', () => {
  it('carries no PAYE, and the run cannot be approved', async () => {
    const f = await seed('2026-12-31', 'P3 hand-made 3901');
    const comp = (await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
       VALUES ($1, 'Gratuity', '3901', 'earning') RETURNING id`, [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
       VALUES ($1, $2, 50000, '2026-06-01', '2026-06-30')`, [f.employee, comp]);
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    const l = await runLine(pool, june, f.employee);
    expect(l).toMatchObject({ gross: 70_000, paye: SALARY_PAYE });
    expect(codes(l.validation_results)).toContain('LUMP_SUM_WITHOUT_DIRECTIVE');
    expect((await previewRun(f, june)).body.data?.blocker?.code).toBe('lump_sum_without_directive');
    const refused = await approveRun(f, june);
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error?.message).toMatch(/W301-1 \(3901\)/);
  });
});

describe('P3: the severance-only line', () => {
  it('takes no ETI, no loan instalment and no salary, beside an employee paid normally', async () => {
    const f = await seed('2026-05-31', 'P3 severance-only, young, with a loan');
    // 23, employed from January 2025: an ETI-qualifying employee while employed.
    await pool.query("UPDATE payroll_employees SET date_of_birth = '2003-01-01', start_date = '2025-01-01' WHERE id = $1", [f.employee]);
    const stayer = String((await pool.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, medical_aid_main_member)
       VALUES ($1, 'P3-STAYER', 'Stay', 'Er', '2020-01-01', '1980-01-01', false) RETURNING id`, [f.company])).rows[0]!.id);
    const salary = String((await pool.query("SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = '3601'", [f.company])).rows[0]!.id);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 20000, '2020-01-01')`,
      [stayer, salary]);
    await pool.query(
      `INSERT INTO payroll_loans(company_id,employee_id,loan_number,description,principal,annual_interest_rate,term_months,method,
         start_date,first_deduction_period_year,first_deduction_period_month,status,outstanding_balance)
       VALUES($1,$2,'P3-LOAN','Staff loan',12000,0.085,12,'straight_line',DATE '2026-01-01',2026,1,'active',10000)`,
      [f.company, f.employee]);
    const may = await createRunFor(f, 5);
    await calculateRun(f, may);
    expect((await approveRun(f, may)).statusCode).toBe(200);
    await approvedDirective(f, 5_000, 0, '2026-06-01');

    const june = await createRunFor(f, 6);
    const summary = await calculateRun(f, june);
    const l = await runLine(pool, june, f.employee);
    expect(breakdownCodes(l)).toEqual(['3901']);
    expect(l).toMatchObject({ gross: 5_000, paye: 0, net: 5_000, uif_employee: 0, sdl: 0 });
    expect(Number((await pool.query('SELECT eti FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [june, f.employee])).rows[0]!.eti)).toBe(0);
    const loanPaid = await pool.query('SELECT 1 FROM payroll_loan_payments WHERE run_id = $1', [june]);
    expect(loanPaid.rowCount).toBe(0);
    expect(summary.body.data?.employeeCount).toBe(2);
  });
});

describe('P3: re-approving a reopened run without the severance releases the claim', () => {
  it('approve → reopen → reverse its journal → directive cancelled → recalculate → approve: no claim left', async () => {
    const f = await seed('2026-06-30', 'P3 claim released');
    const d = await approvedDirective(f, 10_000, 0.1, '2026-06-01');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await approveRun(f, june)).statusCode).toBe(200);
    expect(await directivePayments(pool, d)).toHaveLength(1);

    expect((await reopenRun(f, june)).statusCode).toBe(200);
    const journal = String((await pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [june])).rows[0]!.journal_entry_id);
    const reversed = await f.call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journal, action: 'reverse' } });
    expect(reversed.statusCode, JSON.stringify(reversed.body)).toBe(200);
    await updateTaxDirectiveStatus(f.company, d, 'cancelled', f.admin);
    await calculateRun(f, june);
    expect(breakdownCodes(await runLine(pool, june, f.employee))).toEqual(['3601']);
    expect((await approveRun(f, june)).statusCode).toBe(200);
    expect(await directivePayments(pool, d)).toEqual([]);
  });
});
