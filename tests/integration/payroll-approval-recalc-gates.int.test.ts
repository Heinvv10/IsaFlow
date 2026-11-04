/**
 * Payroll breaker round (Hein, 2026-11-02), through the real routes:
 *   M4: approval refuses a run calculated by code older than this branch (no calculation stamp): recalculate.
 *   M3: approval refuses a run whose employees' component dates changed (Edit dates, End, cancel: audit_log) after it
 *       was calculated: recalculate.
 *   M1: a month counts as paid when its run is approved or paid, or its journal chain is still in force; a reopened
 *       run whose journal was reversed (link kept) no longer is (the October sequence).
 *   L1: End cancels (voids) an assignment no approved run has paid, also a recurring one; a paid one is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import components from '../../pages/api/payroll/employees/[id]/components';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let employee = '';
let salaryRow = '';
let bonus = '';

const url = (aid?: string) => `/api/payroll/employees/${employee}/components${aid ? `?aid=${aid}` : ''}`;
const patch = (aid: string, body: unknown) => call(components as Route, 'PATCH', url(aid), employee, { body, query: { aid } });
const end = (aid: string, body: Record<string, unknown>) => call(components as Route, 'DELETE', url(aid), employee, { body, query: { aid } });
async function blocker(run: string) {
  const out = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${run}/journal-plan`, run);
  expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
  return (out.body.data as { blocker: { code: string; detail: string } | null }).blocker;
}
async function approveRun(run: string) {
  const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${run}/journal-plan`, run);
  return call(approve as Route, 'POST', `/api/payroll/runs/${run}/approve`, run, { body: { expectedPlanHash: plan.body.data?.planHash } });
}
const recalc = (run: string) => call(calculate as Route, 'POST', `/api/payroll/runs/${run}/calculate`, run);
async function assignOnceOff(amount: number, from: string): Promise<string> {
  const out = await call(components as Route, 'POST', url(), employee, { body: { componentId: bonus, amount, effectiveFrom: from, isRecurring: false } });
  expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
  return String(out.body.data!.id);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Recalc gates']);
  salaryRow = await seedPayrollCompany(pool, company);
  employee = String((await pool.query('SELECT employee_id FROM payroll_employee_components WHERE id=$1', [salaryRow])).rows[0]!.employee_id);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  bonus = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Bonus','3605','earning')", [bonus, company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe('M4: a run calculated before the calculation stamp is refused until recalculated', () => {
  it('no stamp: recalculate_required; recalculated: stamped and not refused for it', async () => {
    const run = await calculatedRun(call, 3);
    const stamp = (await pool.query('SELECT calculated_at, calculation_version FROM payroll_run_headers WHERE id=$1', [run])).rows[0];
    expect(stamp.calculated_at).not.toBeNull();
    expect(stamp.calculation_version).toBeGreaterThanOrEqual(1);
    // As every run calculated before migration 953 is.
    await pool.query('UPDATE payroll_run_headers SET calculated_at = NULL, calculation_version = NULL WHERE id=$1', [run]);
    const refused = await blocker(run);
    expect(refused?.code).toBe('recalculate_required');
    expect(refused?.detail).toMatch(/recalculate/i);
    expect((await approveRun(run)).statusCode).toBe(400);
    expect((await recalc(run)).statusCode).toBe(200);
    expect(await blocker(run)).toBeNull();
  });
});

describe('M3: a component date changed after calculation refuses the run until recalculated', () => {
  it('End cancels a once-off after calculation: refused, naming the employee; recalculated: approvable', async () => {
    const once = await assignOnceOff(800, '2026-04-10');
    const run = await calculatedRun(call, 4);
    expect(await blocker(run)).toBeNull();
    expect((await end(once, { effectiveTo: '2026-04-12' })).statusCode).toBe(200);
    const refused = await blocker(run);
    expect(refused?.code).toBe('components_changed_after_calculation');
    expect(refused?.detail).toMatch(/W301-1.*recalculate/i);
    expect((await recalc(run)).statusCode).toBe(200);
    expect(await blocker(run)).toBeNull();
    expect((await approveRun(run)).statusCode).toBe(200);
  });
});

describe('M1: the October sequence', () => {
  it('approved: paid; reopened with its journal in force: paid; journal reversed (link kept): not paid', async () => {
    const october = await calculatedRun(call, 10);
    expect((await approveRun(october)).statusCode).toBe(200);
    // Ending the salary on 20 October takes it out of October only (March is unapproved, April is covered).
    const moveOut = { effectiveFrom: '2020-01-01', effectiveTo: '2026-10-20' };
    expect((await patch(salaryRow, moveOut)).body.error?.message).toMatch(/2026-10 .*already paid/);

    expect((await call(reopen as Route, 'POST', `/api/payroll/runs/${october}/reopen`, october, { body: { reason: 'M1 sequence' } })).statusCode).toBe(200);
    const journal = String((await pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id=$1', [october])).rows[0].journal_entry_id);
    expect(journal).not.toBe('null');
    expect((await patch(salaryRow, moveOut)).statusCode).toBe(400);

    await reverseJournalEntry(company, journal, admin); // the GL's own reversal: the run keeps its link
    expect(String((await pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id=$1', [october])).rows[0].journal_entry_id)).toBe(journal);
    const out = await patch(salaryRow, moveOut);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
  });
});

describe('L1: End cancels what no approved run has paid', () => {
  it('a recurring row that has not started, ended today: voided, not refused', async () => {
    const out = await call(components as Route, 'POST', url(), employee, { body: { componentId: bonus, amount: 500, effectiveFrom: '2027-02-01', isRecurring: true } });
    const id = String(out.body.data!.id);
    expect((await end(id, { effectiveTo: '2026-11-02' })).statusCode).toBe(200);
    expect((await pool.query('SELECT effective_to < effective_from AS voided FROM payroll_employee_components WHERE id=$1', [id])).rows[0].voided).toBe(true);
  });

  it('cancel on a row an approved run paid: refused, nothing written', async () => {
    const before = (await pool.query("SELECT to_char(effective_to,'YYYY-MM-DD') AS t FROM payroll_employee_components WHERE id=$1", [salaryRow])).rows[0];
    const out = await end(salaryRow, { effectiveTo: '2026-04-30', cancel: true });
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toMatch(/already paid/i);
    expect((await pool.query("SELECT to_char(effective_to,'YYYY-MM-DD') AS t FROM payroll_employee_components WHERE id=$1", [salaryRow])).rows[0]).toEqual(before);
  });
});
