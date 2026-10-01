/**
 * BRK-596 breaker rig (adversarial round on 25170a6fd), ported into the repo
 * with its suites `brkr-c*.int.test.ts` in W3-01 round 5. Real route handlers
 * (withAuth, app_user, RLS) against the disposable fixture. Built to run on
 * origin/master too, where the journal-plan route (and the hash) do not exist,
 * hence the dynamic import. Each suite asserts a CLAIM; where round 5 decided a
 * behaviour the original repro did not expect, the suite says so at that step.
 */
import { appendFileSync } from 'fs';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import createRun from '../../pages/api/payroll/runs';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

export type Route = (req: never, res: never) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Res = { statusCode: number; body: { data?: Record<string, any>; message?: string; error?: any } };

export const REQUIRED_GL = ['5200', '2140', '2150', '2160', '1110', '2175'];

export async function rig(label: string) {
  assertDisposable();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  const company = crypto.randomUUID();
  const admin = crypto.randomUUID();
  const tokens: Record<string, string> = {};
  const planPath = '../../pages/api/payroll/runs/[id]/journal-plan';
  const journalPlan: Route | null = await import(/* @vite-ignore */ planPath).then((m) => m.default as Route).catch(() => null);

  const mint = async (user: string) => new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

  async function call(route: Route, method: string, url: string, id: unknown, opts: { company?: string; user?: string; body?: unknown } = {}): Promise<Res> {
    const req = request({ 'sb-access-token': tokens[opts.user ?? admin]!, active_company_id: opts.company ?? company }, method) as never as {
      url: string; body: unknown; query: Record<string, unknown>;
    };
    req.query = id === undefined ? {} : { id };
    req.url = url;
    req.body = opts.body;
    const result = response();
    await route(req as never, result.res as never);
    return result.state as Res;
  }

  const url = (id: string, action: string) => `/api/payroll/runs/${id}/${action}`;
  const api = {
    preview: (id: string, o = {}) => journalPlan ? call(journalPlan, 'GET', url(id, 'journal-plan'), id, o) : Promise.resolve({ statusCode: 0, body: {} } as Res),
    approveWith: (id: string, expectedPlanHash: unknown, o = {}) => call(approve as Route, 'POST', url(id, 'approve'), id, { ...o, body: { expectedPlanHash } }),
    approve: async (id: string, o = {}) => api.approveWith(id, (await api.preview(id, o)).body.data?.planHash, o),
    reopen: (id: string, o = {}) => call(reopen as Route, 'POST', url(id, 'reopen'), id, { ...o, body: { reason: 'brk596 round 4' } }),
    calculate: (id: string, o = {}) => call(calculate as Route, 'POST', url(id, 'calculate'), id, o),
    createRun: (month: number, o = {}) => call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { ...o, body: { month, year: 2026 } }),
    reverse: (journalId: string, o = {}) => call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { ...o, body: { id: journalId, action: 'reverse' } }),
  };

  async function account(code: string, c = company): Promise<string> {
    const type = code.startsWith('5') ? 'expense' : code === '1110' ? 'asset' : 'liability';
    return (await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
       VALUES ($1,$2,$3,$4,$5,1) RETURNING id`, [c, code, `BRK ${code}`, type, type === 'liability' ? 'credit' : 'debit'])).rows[0]!.id;
  }
  let empSeq = 0;
  /** An employee with a Basic Salary. Returns { employee, salaryRow }. */
  async function employee(salary: number, c = company): Promise<{ employee: string; salaryRow: string }> {
    empSeq += 1;
    const emp = (await pool.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number)
       VALUES ($1, $2, 'Brk', $2, '2020-01-01', '1980-01-01', $3) RETURNING id`,
      [c, `BRK-${empSeq}`, String(1000000000 + Math.floor(Math.random() * 899999999))])).rows[0]!.id;
    let comp = (await pool.query(`SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Basic Salary'`, [c])).rows[0]?.id;
    comp ??= (await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
       VALUES ($1, 'Basic Salary', '3601', 'earning') RETURNING id`, [c])).rows[0]!.id;
    const salaryRow = (await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from)
       VALUES ($1, $2, $3, '2020-01-01') RETURNING id`, [emp, comp, salary])).rows[0]!.id;
    return { employee: emp, salaryRow };
  }
  const setSalary = (row: string, amount: number) => pool.query('UPDATE payroll_employee_components SET amount = $1 WHERE id = $2', [amount, row]);

  async function setup(): Promise<void> {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, `BRK596 ${label}`]);
    for (const code of REQUIRED_GL) await account(code);
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
    tokens[admin] = await mint(admin);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  }
  async function addUser(role: string, c = company): Promise<string> {
    const u = crypto.randomUUID();
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)", [u, `${u}@test.local`]);
    tokens[u] = await mint(u);
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [c, u, role]);
    return u;
  }

  /** A run for (2026, month) created and costed through the real routes. */
  async function calculatedRun(month: number): Promise<string> {
    const made = await api.createRun(month);
    if (made.statusCode !== 201) throw new Error(`create run ${month}: ${made.statusCode} ${JSON.stringify(made.body)}`);
    const id = String(made.body.data!.id);
    const calc = await api.calculate(id);
    if (calc.statusCode !== 200) throw new Error(`calculate ${month}: ${calc.statusCode} ${JSON.stringify(calc.body)}`);
    return id;
  }

  const header = async (id: string) => (await pool.query(
    `SELECT status, journal_entry_id, total_gross::float8 AS gross, total_paye::float8 AS paye, total_net::float8 AS net
       FROM payroll_run_headers WHERE id = $1`, [id])).rows[0]!;
  /** Every journal of the company whose description names this month, with what it is. */
  const journals = async (mm: string) => (await pool.query(
    `SELECT e.id, e.entry_number, e.status, e.description, e.entry_date::text AS entry_date,
            (e.reversed_at IS NOT NULL) AS reversed, e.reversal_of_id,
            (SELECT COALESCE(sum(l.debit),0)::float8 FROM gl_journal_lines l WHERE l.journal_entry_id = e.id) AS total_debit
       FROM gl_journal_entries e WHERE e.company_id = $1 ORDER BY e.created_at, e.entry_number`, [company])).rows
    .filter((r) => mm === '*' || String(r.description).includes(`2026-${mm}`) || r.reversal_of_id != null);
  /** Net posted balance (debit − credit) per account code over ALL posted journals of the company dated in the month. */
  const ledger = async (month?: number) => Object.fromEntries((await pool.query(
    `SELECT a.account_code, sum(l.debit - l.credit)::float8 AS net
       FROM gl_journal_lines l
       JOIN gl_journal_entries e ON e.id = l.journal_entry_id
       JOIN gl_accounts a ON a.id = l.gl_account_id
      WHERE e.company_id = $1 AND e.status = 'posted'
        AND ($2::int IS NULL OR e.description LIKE '%' || 'Payroll run 2026-' || lpad($2::text, 2, '0') || '%'
             OR e.id IN (WITH RECURSIVE chain AS (
                  SELECT id FROM gl_journal_entries WHERE company_id = $1 AND description = 'Payroll run 2026-' || lpad($2::text, 2, '0')
                  UNION SELECT c.id FROM gl_journal_entries c JOIN chain ON c.reversal_of_id = chain.id) SELECT id FROM chain))
      GROUP BY a.account_code ORDER BY a.account_code`, [company, month ?? null])).rows.map((r) => [r.account_code, r.net]));

  async function teardown(extraCompanies: string[] = []): Promise<void> {
    const ids = [company, ...extraCompanies];
    const q = (text: string) => pool.query(text, [ids]);
    try {
      await q('DELETE FROM payroll_loan_payment_reversals WHERE company_id = ANY($1)').catch(() => undefined);
      await q('DELETE FROM payroll_loan_payments WHERE loan_id IN (SELECT id FROM payroll_loans WHERE company_id = ANY($1))').catch(() => undefined);
      await q('DELETE FROM payroll_loan_schedule WHERE loan_id IN (SELECT id FROM payroll_loans WHERE company_id = ANY($1))');
      await q('DELETE FROM payroll_loans WHERE company_id = ANY($1)');
      await q('DELETE FROM payroll_employee_cost_allocations WHERE company_id = ANY($1)');
      await q('DELETE FROM cost_centre_gl_mappings WHERE company_id = ANY($1)');
      await q('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ANY($1))');
      await q('DELETE FROM payroll_run_headers WHERE company_id = ANY($1)');
      await q('DELETE FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id = ANY($1))');
      await q('DELETE FROM payroll_employees WHERE company_id = ANY($1)');
      await q('DELETE FROM payroll_components WHERE company_id = ANY($1)');
      await q('DELETE FROM cost_centres WHERE company_id = ANY($1)');
      await q('UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ANY($1)');
      await q('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = ANY($1))');
      await q('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)');
      await q('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ANY($1))');
      await q('DELETE FROM gl_accounts WHERE company_id = ANY($1)');
      await q('DELETE FROM fiscal_periods WHERE company_id = ANY($1)');
      await q('DELETE FROM company_users WHERE company_id = ANY($1)');
      await q('DELETE FROM companies WHERE id = ANY($1)');
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [Object.keys(tokens)]);
    } finally { await pool.end(); }
  }

  const msg = (x: Res): string | undefined => x.body?.error?.message ?? x.body?.message ?? (typeof x.body?.error === 'string' ? x.body.error : undefined);
  const evidence = (name: string, data: unknown) => {
    if (process.env.BRK_EVIDENCE) appendFileSync(process.env.BRK_EVIDENCE, `\n=== EVIDENCE ${name} ===\n${JSON.stringify(data, null, 1)}\n`);
  };
  const contraOf = async (journalId: string) => String((await pool.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1', [journalId])).rows[0]?.id);
  return { pool, company, admin, tokens, call, api, account, employee, setSalary, setup, addUser, calculatedRun, header, journals, ledger, teardown, evidence, contraOf, hasPlanRoute: journalPlan != null, mint, msg };
}
