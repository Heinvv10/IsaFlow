/**
 * Fixture of the pay-run period-input suites. Every test gets its own company A with one
 * employee and a November run costed through the real routes, so no test leans on what
 * another left behind. Company B and the two users last the whole file.
 * The admin belongs to A and B with A active, so company B's run is kept out by the
 * service asking with A's company id, not by RLS membership.
 */
import type { Pool } from 'pg';
import { SignJWT } from 'jose';
import inputs from '../../pages/api/payroll/runs/[id]/inputs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

export const SALARY = 20000;

type StoredRow = { amount: number; is_recurring: boolean };

export function inputsFixture(pool: Pool) {
  const [coB, admin, viewer] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const who = { user: admin, company: '' };
  const tokens: Record<string, string> = {};
  const call = routeCaller(tokens, who);
  const state = { coA: '', employee: '', employeeB: '', nov: '', runB: '', comp: {} as Record<string, string> };

  const url = (id: string) => `/api/payroll/runs/${id}/inputs`;
  const addComponent = async (company: string, name: string, code: string, type: string, taxable: boolean, active = true) => (await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable, is_active)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [company, name, code, type, taxable, active])).rows[0]!.id as string;
  const rows = async (component: string, employeeId = state.employee) => (await pool.query(
    `SELECT id, amount::float8 AS amount, is_recurring, effective_from::text AS "from", effective_to::text AS "to"
       FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2`, [employeeId, component])).rows;
  const put = (run: string, body: unknown, opts: { user?: string } = {}) => call(inputs as Route, 'PUT', url(run), run, { ...opts, body });
  /** PUT as the grid sends it: expectedAmount is what is stored now, unless the test says otherwise. */
  const set = async (run: string, component: string, amount: unknown, employeeId = state.employee, expectedAmount?: number) =>
    put(run, { employeeId, componentId: component, amount, expectedAmount: expectedAmount ?? ((await rows(component, employeeId)) as StoredRow[]).find((r) => !r.is_recurring)?.amount ?? 0 });

  return {
    state, coB, admin, viewer, who, call, put, set, rows, addComponent,
    get: (run: string) => call(inputs as Route, 'GET', url(run), run),
    recalculate: (run: string) => call(calculate as Route, 'POST', `/api/payroll/runs/${run}/calculate`, run),
    line: async (run: string, employeeId = state.employee) => (await pool.query(
      `SELECT gross_pay::float8 AS gross, paye::float8 AS paye, uif_employee::float8 AS uif, sdl::float8 AS sdl, net_pay::float8 AS net, validation_results
         FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2`, [run, employeeId])).rows[0]!,
    header: async (run: string) => (await pool.query(
      `SELECT status, journal_entry_id, total_gross::float8 AS gross, total_net::float8 AS net FROM payroll_run_headers WHERE id = $1`, [run])).rows[0]!,
    preview: (id: string) => call(journalPlan as Route, 'GET', `/api/payroll/runs/${id}/journal-plan`, id),
    doApprove: (id: string, expectedPlanHash: unknown) =>
      call(approve as Route, 'POST', `/api/payroll/runs/${id}/approve`, id, { body: { expectedPlanHash } }),
    /** A row the run reads, written as a batch or the employee page writes it. */
    addRow: (component: string, amount: number, from: string, to: string | null, recurring = false, employeeId = state.employee) => pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
       VALUES ($1, $2, $3, $4, $5, $6)`, [employeeId, component, amount, from, to, recurring]),
    /** A loan with one instalment due in November, as the loan service schedules it. */
    addLoan: async (instalment: number, loanNumber = 'R-LOAN') => {
      const loan = crypto.randomUUID();
      await pool.query(
        `INSERT INTO payroll_loans (id, company_id, employee_id, loan_number, description, principal, annual_interest_rate, term_months,
           method, start_date, first_deduction_period_year, first_deduction_period_month, status, outstanding_balance)
         VALUES ($1, $2, $3, $4, 'Staff loan', $5, 0.085, 1, 'straight_line', '2026-11-01', 2026, 11, 'active', $5)`,
        [loan, state.coA, state.employee, loanNumber, instalment]);
      await pool.query(
        `INSERT INTO payroll_loan_schedule (loan_id, sequence, due_period_year, due_period_month, opening_balance, interest, principal, installment, closing_balance, paid_flag)
         VALUES ($1, 1, 2026, 11, $2, 0, $2, $2, 0, false)`, [loan, instalment]);
      return loan;
    },
    /** Waiting on this advisory lock itself: classid and objid are the key's high and low 32 bits. */
    lockWaiters: async (key: string) => (await pool.query(
      `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
         AND (classid::bigint << 32 | objid::bigint) = hashtextextended($1, 0)`, [key])).rowCount,
    /** A second employee of company A, on no pay at all until a test gives them some. */
    addEmployee: async (number: string) => (await pool.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number)
       VALUES ($1, $2, 'Second', 'Employee', '2020-01-01', '1985-01-01', '0123456780') RETURNING id`, [state.coA, number])).rows[0]!.id as string,

    async setUp() {
      await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [coB, 'R inputs B']);
      await seedPayrollCompany(pool, coB, SALARY);
      state.employeeB = (await pool.query('SELECT id FROM payroll_employees WHERE company_id = $1', [coB])).rows[0]!.id;
      for (const [id, email, role] of [[admin, 'a', 'admin'], [viewer, 'v', 'viewer']] as const) {
        await pool.query('INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, $3, true)', [id, `${email}-${id}@test.local`, role]);
        tokens[id] = await new SignJWT({ sub: id, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
          .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
      }
      await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', false)`, [coB, admin]);
      state.comp.foreign = await addComponent(coB, 'Overtime B', '3607', 'earning', true);
      who.company = coB;
      state.runB = await calculatedRun(call, 11);
    },

    async freshCompany() {
      const coA = crypto.randomUUID();
      state.coA = coA;
      who.company = coA;
      await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [coA, 'R inputs A']);
      await seedPayrollCompany(pool, coA, SALARY);
      state.employee = (await pool.query('SELECT id FROM payroll_employees WHERE company_id = $1', [coA])).rows[0]!.id;
      await pool.query(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
         VALUES ($1, '2175', 'R deductions', 'liability', 'credit', 1)`, [coA]);
      await pool.query(
        `INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true), ($1, $3, 'viewer', true)`, [coA, admin, viewer]);
      const c = state.comp;
      c.overtime = await addComponent(coA, 'Overtime', '3607', 'earning', true);
      c.commission = await addComponent(coA, 'Commission', '3606', 'earning', true);
      c.union = await addComponent(coA, 'Union dues', 'UNION', 'deduction', false);
      c.medical = await addComponent(coA, 'Medical Aid', '4005', 'deduction', false);
      c.provident = await addComponent(coA, 'Provident Fund', '4001', 'deduction', false);
      c.bonus = await addComponent(coA, 'Annual Bonus', '3605', 'earning', true);
      c.advance = await addComponent(coA, 'Salary Advance', '3907', 'deduction', false);
      c.loan = await addComponent(coA, 'Loan repayment', 'LOAN', 'deduction', false);
      c.taxedDeduction = await addComponent(coA, 'Salary sacrifice', 'SACR', 'deduction', true);
      c.inactive = await addComponent(coA, 'Old overtime', '3607', 'earning', true, false);
      state.nov = await calculatedRun(call, 11);
    },

    async dropCompany() {
      const company = [state.coA];
      await pool.query('DELETE FROM payroll_loan_payments WHERE loan_id IN (SELECT id FROM payroll_loans WHERE company_id = ANY($1))', [company]);
      await pool.query('DELETE FROM payroll_loan_schedule WHERE loan_id IN (SELECT id FROM payroll_loans WHERE company_id = ANY($1))', [company]);
      await pool.query('DELETE FROM payroll_loans WHERE company_id = ANY($1)', [company]);
      await cleanPayrollCompanies(pool, company);
    },

    async tearDown() {
      try {
        await cleanPayrollCompanies(pool, [coB]);
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, viewer]]);
      } finally {
        await pool.end();
      }
    },
  };
}
