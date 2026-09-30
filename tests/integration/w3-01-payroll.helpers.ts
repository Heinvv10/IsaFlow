/**
 * W3-01 integration fixtures that reach payroll state only the way the product
 * does: a real employee with a real pay component, a run created by
 * POST /api/payroll/runs and costed by POST …/calculate. No header or journal
 * row is written by hand, so no test can pass on a state the code never writes.
 */
import type { Pool } from 'pg';
import { request, response } from './mfa-impersonation-postgres.helpers';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';

export type Route = (req: never, res: never) => Promise<unknown>;
export type Body = { data?: Record<string, any>; error?: { message?: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

export const REQUIRED_GL = ['5200', '2140', '2150', '2160', '1110'];

/** GL accounts, one active employee and a Basic Salary earning for `company`. Returns the salary row id. */
export async function seedPayrollCompany(pool: Pool, company: string, salary = 20000): Promise<string> {
  for (const code of REQUIRED_GL) {
    const type = code === '5200' ? 'expense' : code === '1110' ? 'asset' : 'liability';
    await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
       VALUES ($1,$2,$3,$4,$5,1)`, [company, code, `W301 ${code}`, type, type === 'liability' ? 'credit' : 'debit']);
  }
  const emp = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number)
     VALUES ($1, 'W301-1', 'Wanda', 'Test', '2020-01-01', '1980-01-01', '0123456789') RETURNING id`, [company])).rows[0]!.id;
  const comp = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
     VALUES ($1, 'Basic Salary', '3601', 'earning') RETURNING id`, [company])).rows[0]!.id;
  return (await pool.query<{ id: string }>(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from)
     VALUES ($1, $2, $3, '2020-01-01') RETURNING id`, [emp, comp, salary])).rows[0]!.id;
}

export function routeCaller(tokens: Record<string, string>, defaults: { user: string; company: string }) {
  return async function call(route: Route, method: string, url: string, id: unknown, opts: { company?: string; user?: string; body?: unknown } = {}) {
    const req = request({ 'sb-access-token': tokens[opts.user ?? defaults.user]!, active_company_id: opts.company ?? defaults.company }, method) as never as {
      url: string; body: unknown; query: Record<string, unknown>;
    };
    req.query = id === undefined ? {} : { id };
    req.url = url;
    req.body = opts.body;
    const result = response();
    await route(req as never, result.res as never);
    return result.state as { statusCode: number; body: Body };
  };
}

/** A run for (2026, month) made and costed through the real routes. */
export async function calculatedRun(call: ReturnType<typeof routeCaller>, month: number, opts: { company?: string } = {}): Promise<string> {
  const made = await call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { ...opts, body: { month, year: 2026 } });
  if (made.statusCode !== 201) throw new Error(`create run ${month}: ${made.statusCode} ${JSON.stringify(made.body)}`);
  const id = String(made.body.data!.id);
  const calc = await call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id, opts);
  if (calc.statusCode !== 200) throw new Error(`calculate ${month}: ${calc.statusCode} ${JSON.stringify(calc.body)}`);
  return id;
}

/** Delete everything the fixtures above (and approval) wrote for these companies. */
export async function cleanPayrollCompanies(pool: Pool, ids: string[]): Promise<void> {
  const q = (text: string) => pool.query(text, [ids]);
  await q('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ANY($1))');
  await q('DELETE FROM payroll_run_headers WHERE company_id = ANY($1)');
  await q('DELETE FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id = ANY($1))');
  await q('DELETE FROM payroll_employees WHERE company_id = ANY($1)');
  await q('DELETE FROM payroll_components WHERE company_id = ANY($1)');
  await q('UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ANY($1)');
  await q('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = ANY($1))');
  await q('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)');
  await q('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ANY($1))');
  await q('DELETE FROM gl_accounts WHERE company_id = ANY($1)');
  await q('DELETE FROM fiscal_periods WHERE company_id = ANY($1)');
  await q('DELETE FROM company_users WHERE company_id = ANY($1)');
  await q('DELETE FROM companies WHERE id = ANY($1)');
}
