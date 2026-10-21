/**
 * Audit 2026-10-18 P3 fixtures: a company with one retrenched employee (the
 * W3-01 employee, R20 000 a month, born 1980, started 2020-01-01, no medical aid),
 * its admin,
 * and the real routes that create, calculate, approve and reopen runs and pay
 * a directive outside payroll. Directives are made by taxDirectiveService, as
 * the tax-directives routes make them.
 */
import type { Pool } from 'pg';
import { SignJWT } from 'jose';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import createRun from '../../pages/api/payroll/runs';
import applyDirective from '../../pages/api/accounting/tax-directives/[id]/apply';
import { cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import { setTerminationDetails, computeTerminationPreview, yearsOfService } from '@/modules/accounting/services/payroll/payrollTerminationService';
import { createTaxDirective, updateTaxDirectiveStatus } from '@/modules/accounting/services/payroll/taxDirectiveService';

export const MONTHLY = 20_000;
/** 20 000 × 12 = 240 000 × 18% = 43 200 − 17 820 (2027 primary rebate) = 25 380 / 12. */
export const SALARY_PAYE = 2115;

export interface SeveranceFixture {
  company: string;
  employee: string;
  admin: string;
  token: string;
  call: ReturnType<typeof routeCaller>;
}

export async function seedRetrenchedEmployee(pool: Pool, endDate: string, name: string): Promise<SeveranceFixture> {
  const company = crypto.randomUUID();
  const admin = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, name]);
  await seedPayrollCompany(pool, company, MONTHLY);
  const employee = String((await pool.query('SELECT id FROM payroll_employees WHERE company_id = $1', [company])).rows[0]!.id);
  await pool.query(
    `UPDATE payroll_employees SET end_date = $2::date, status = 'terminated', id_number = '8001015009087',
           medical_aid_main_member = false WHERE id = $1`,
    [employee, endDate]);
  await setTerminationDetails(company, employee, {
    reason: 'retrenchment', noticePeriodDays: 30, servedNoticeDays: 30, severanceWeeksPerYear: 1, includeLeavePayout: false,
  });
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  const tokens: Record<string, string> = {};
  tokens[admin] = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return { company, employee, admin, token: tokens[admin]!, call: routeCaller(tokens, { user: admin, company }) };
}

/** The severance the termination flow calculates for this employee leaving on `endDate`. */
export function calculatedSeverance(endDate: string): number {
  return computeTerminationPreview({
    monthlySalary: MONTHLY, unusedLeaveDays: 0, noticePeriodDays: 30, servedNoticeDays: 30,
    severanceWeeksPerYear: 1, yearsOfService: yearsOfService('2020-01-01', endDate),
    includeLeavePayout: false, reason: 'retrenchment',
  }).severancePay;
}

/** An approved severance directive, made and approved as the tax-directives routes do. */
export async function approvedDirective(
  f: SeveranceFixture, amount: number, taxRate: number, effectiveDate: string, number = '1234567890',
): Promise<string> {
  const d = await createTaxDirective(f.company, {
    employee_id: f.employee, employee_name: 'Wanda Test', directive_number: number, directive_type: 'severance',
    amount, tax_rate: taxRate, effective_date: effectiveDate,
  }, f.admin);
  await updateTaxDirectiveStatus(f.company, d.id, 'approved', f.admin);
  return d.id;
}

const url = (id: string, action: string) => `/api/payroll/runs/${id}/${action}`;

export async function createRunFor(f: SeveranceFixture, month: number): Promise<string> {
  const made = await f.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year: 2026 } });
  if (made.statusCode !== 201) throw new Error(`create run ${month}: ${made.statusCode} ${JSON.stringify(made.body)}`);
  return String(made.body.data!.id);
}

export async function calculateRun(f: SeveranceFixture, id: string) {
  const r = await f.call(calculate as Route, 'POST', url(id, 'calculate'), id);
  if (r.statusCode !== 200) throw new Error(`calculate: ${r.statusCode} ${JSON.stringify(r.body)}`);
  return r;
}

/** The approval preview (GET …/journal-plan): plan, blocker and hash. */
export const previewRun = (f: SeveranceFixture, id: string) => f.call(journalPlan as Route, 'GET', url(id, 'journal-plan'), id);

export async function approveRun(f: SeveranceFixture, id: string) {
  const plan = await previewRun(f, id);
  return f.call(approve as Route, 'POST', url(id, 'approve'), id, { body: { expectedPlanHash: plan.body.data?.planHash } });
}

export const reopenRun = (f: SeveranceFixture, id: string) =>
  f.call(reopen as Route, 'POST', url(id, 'reopen'), id, { body: { reason: 'p3 reopen test' } });

export const applyStandalone = (f: SeveranceFixture, directiveId: string, paymentDate = '2026-09-15') =>
  f.call(applyDirective as Route, 'POST', `/api/accounting/tax-directives/${directiveId}/apply`, directiveId, { body: { paymentDate } });

export async function runLine(pool: Pool, runId: string, employeeId: string) {
  return (await pool.query(
    `SELECT gross_pay::float8 AS gross, paye::float8 AS paye, uif_employee::float8 AS uif_employee,
            uif_employer::float8 AS uif_employer, sdl::float8 AS sdl, net_pay::float8 AS net,
            component_breakdown, validation_results
       FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2`, [runId, employeeId])).rows[0];
}

export async function directivePayments(pool: Pool, directiveId: string) {
  return (await pool.query(
    `SELECT payroll_run_id, gross_amount::float8 AS gross, paye_amount::float8 AS paye, net_amount::float8 AS net, journal_entry_id
       FROM tax_directive_payments WHERE tax_directive_id = $1`, [directiveId])).rows;
}

export const codes = (validation: unknown) => (validation as Array<{ code: string }>).map(v => v.code);

export async function cleanSeveranceFixtures(pool: Pool, fixtures: SeveranceFixture[]): Promise<void> {
  const ids = fixtures.map(f => f.company);
  await pool.query('DELETE FROM tax_directive_payments WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM tax_directives WHERE company_id = ANY($1)', [ids]);
  await cleanPayrollCompanies(pool, ids);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [fixtures.map(f => f.admin)]);
}
