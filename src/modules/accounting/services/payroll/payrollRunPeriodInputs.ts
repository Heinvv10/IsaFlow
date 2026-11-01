/**
 * Once-off period amounts for the pay-run review grid (master plan wave 3, R;
 * decision 7). The row key is (employee, component, is_recurring = false, the
 * run month's first and last day): the grid edits the one row that matches,
 * whoever wrote it (a batch, MCP, the grid), and refuses when several match.
 * Telling grid rows from others would need a source column.
 *
 * WHICH COMPONENTS. Regular pay and deductions with no tax effect, nothing else:
 *   - earnings: 3601 salary, 3606 commission, 3607 overtime, flagged taxable.
 *     3605 and the 39xx lump sums are taxed by other rules (payeTreatment).
 *   - deductions: not taxable (the calculator takes a taxable deduction off PAYE
 *     income) and carrying a company-local code. Every four-digit code is a SARS
 *     code with a meaning beyond the payslip: the retirement and medical families
 *     move PAYE or a certificate field, and any 39xx in a run's breakdown, even on
 *     a deduction, trips the approval gate's lump_sum_without_directive.
 *     LOAN belongs to the loan service, which pairs it with a balance.
 *   - employer_contribution never: the calculator does not process it.
 *
 * ORDER (rule 9; a 4xx commits). setRunPeriodAmount takes the locks in the order
 * of every payroll-run writer (payrollRunLock.ts), judges everything under them,
 * and only then writes and recalculates in the request transaction. The stored
 * lines therefore always reflect the inputs, and approve cannot read a stale
 * calculation produced here. Anything thrown after the write is NOT a
 * PayrollRunInputRefusedError, so the route lets it become a 500 and rolls back.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { endOfMonthIso } from './leaveAccrualService';
import { normaliseSarsCode } from './payeAnnualPayment';
import { journalInForceOrNull } from './payrollJournalChain';
import { listPayrollRunEmployees } from './payrollEmployeeService';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader } from './payrollRunLock';
import { PayrollRunJournalPostedError, runHasLoanWork } from './payrollRunLoanApplication';
import {
  calculatePayrollRun, getPayrollRun, getPayrollRunLines, type PayrollRunLine, type PayrollRunSummary,
} from './payrollRunService';
import { getTaxYear, getTaxYearConfig, UnsupportedTaxYearError } from './taxTables';

const EDITABLE_EARNING_CODES: ReadonlySet<string> = new Set(['3601', '3606', '3607']);
const SARS_CODE = /^\d{4}$/;
const EDITABLE_STATUSES: ReadonlySet<string> = new Set(['draft', 'calculated']);
/** NUMERIC(14,2). */
const MAX_AMOUNT = 999_999_999_999.99;
const MULTIPLE_ROWS = 'Edit this on the employee page: more than one amount is captured for this component this month.';

export interface EditableComponentFacts {
  sarsSourceCode: string;
  componentType: string;
  isTaxable: boolean;
}

export function isEditableRunComponent(c: EditableComponentFacts): boolean {
  const code = normaliseSarsCode(c.sarsSourceCode);
  if (c.componentType === 'earning') return c.isTaxable && EDITABLE_EARNING_CODES.has(code);
  if (c.componentType === 'deduction') return !c.isTaxable && !SARS_CODE.test(code) && code.toUpperCase() !== 'LOAN';
  return false;
}

/** Raised only before the first write, so answering it as a 4xx commits nothing. */
export class PayrollRunInputRefusedError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'PayrollRunInputRefusedError';
    this.status = status;
  }
}

export interface RunInputComponent {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: 'earning' | 'deduction';
}

export interface RunInputAmount {
  employeeId: string;
  componentId: string;
  /** Null when several rows match: the grid cannot say which one a cell would be. */
  amount: number | null;
  conflict: boolean;
}

export interface RunInputsState {
  run: PayrollRunSummary & { lines: PayrollRunLine[] };
  inputs: { components: RunInputComponent[]; employeeIds: string[]; amounts: RunInputAmount[] };
}

interface Period { year: number; month: number }

const monthBounds = ({ year, month }: Period) => ({
  from: `${year}-${String(month).padStart(2, '0')}-01`,
  to: endOfMonthIso(year, month),
});

async function listEditableComponents(companyId: string): Promise<RunInputComponent[]> {
  const rows = (await sql`
    SELECT id, name, sars_source_code, component_type, is_taxable
    FROM payroll_components
    WHERE company_id = ${companyId}::uuid AND is_active = TRUE
    ORDER BY name
  `) as DbRow[];
  return rows
    .filter((r) => isEditableRunComponent({
      sarsSourceCode: String(r.sars_source_code), componentType: String(r.component_type), isTaxable: r.is_taxable === true,
    }))
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      sarsSourceCode: normaliseSarsCode(String(r.sars_source_code)),
      componentType: r.component_type as RunInputComponent['componentType'],
    }));
}

async function readAmounts(companyId: string, period: Period, componentIds: string[]): Promise<RunInputAmount[]> {
  const { from, to } = monthBounds(period);
  const rows = (await sql`
    SELECT pec.employee_id, pec.component_id, COUNT(*)::int AS matches, MIN(pec.amount)::float8 AS amount
    FROM payroll_employee_components pec
    JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = ${companyId}::uuid
    WHERE pec.component_id = ANY(${componentIds}::uuid[])
      AND pec.is_recurring = FALSE AND pec.effective_from = ${from}::date AND pec.effective_to = ${to}::date
    GROUP BY pec.employee_id, pec.component_id
  `) as DbRow[];
  return rows.map((r) => {
    const conflict = Number(r.matches) > 1;
    return { employeeId: String(r.employee_id), componentId: String(r.component_id), amount: conflict ? null : Number(r.amount), conflict };
  });
}

/** The grid's state: the run with its lines, what it may edit, and what is captured for the run month. Null: not this company's. */
export async function getRunInputs(companyId: string, runId: string): Promise<RunInputsState | null> {
  const run = await getPayrollRun(runId, companyId);
  if (!run) return null;
  const period = { year: run.periodYear, month: run.periodMonth };
  // One after another: under withAuth these share the request's one connection.
  const lines = await getPayrollRunLines(runId, companyId);
  const employees = await listPayrollRunEmployees(companyId, period);
  const components = await listEditableComponents(companyId);
  const amounts = await readAmounts(companyId, period, components.map((c) => c.id));
  return { run: { ...run, lines }, inputs: { components, employeeIds: employees.map((e) => e.id), amounts } };
}

function assertAmount(amount: number): void {
  const cents = amount * 100;
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT || Math.abs(cents - Math.round(cents)) > 1e-6) {
    throw new PayrollRunInputRefusedError(400, 'Enter an amount of zero or more, to the cent.');
  }
}

async function assertRunEditable(companyId: string, runId: string, run: DbRow, period: Period): Promise<void> {
  if (!EDITABLE_STATUSES.has(String(run.status))) {
    throw new PayrollRunInputRefusedError(400, `This run is ${String(run.status)}: only a draft or calculated run can be edited.`);
  }
  try {
    getTaxYearConfig(getTaxYear(period.month, period.year));
  } catch (err) {
    if (err instanceof UnsupportedTaxYearError) throw new PayrollRunInputRefusedError(400, err.message);
    throw err;
  }
  // calculatePayrollRun's own refusal, judged before the write. Its loans are re-read under their lock there: a loan
  // added in between surfaces as this error after the write, and the route answers that as a 500, which rolls back.
  if (await journalInForceOrNull(companyId, run.journal_entry_id) != null
    && await runHasLoanWork(companyId, runId, period.year, period.month)) {
    throw new PayrollRunInputRefusedError(400, new PayrollRunJournalPostedError(runId).message);
  }
}

export async function setRunPeriodAmount(
  companyId: string,
  runId: string,
  employeeId: string,
  componentId: string,
  amount: number,
): Promise<RunInputsState> {
  assertAmount(amount);
  await lockCompanyPayrollApprovals(runId, companyId);
  const run = await lockPayrollRunHeader(runId, companyId);
  if (!run) throw new PayrollRunInputRefusedError(404, 'Payroll run not found');

  const period: Period = { year: Number(run.period_year), month: Number(run.period_month) };
  await assertRunEditable(companyId, runId, run, period);
  const employees = await listPayrollRunEmployees(companyId, period);
  if (!employees.some((e) => e.id === employeeId)) throw new PayrollRunInputRefusedError(400, 'This employee is not on this run.');
  if (!(await listEditableComponents(companyId)).some((c) => c.id === componentId)) {
    throw new PayrollRunInputRefusedError(400, 'This component cannot be edited on a pay run: use the employee page.');
  }

  const { from, to } = monthBounds(period);
  const matches = (await sql`
    SELECT pec.id
    FROM payroll_employee_components pec
    JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = ${companyId}::uuid
    WHERE pec.employee_id = ${employeeId}::uuid AND pec.component_id = ${componentId}::uuid
      AND pec.is_recurring = FALSE AND pec.effective_from = ${from}::date AND pec.effective_to = ${to}::date
    FOR UPDATE OF pec
  `) as DbRow[];
  if (matches.length > 1) throw new PayrollRunInputRefusedError(409, MULTIPLE_ROWS);

  const rowId = matches[0]?.id == null ? null : String(matches[0].id);
  if (rowId && amount === 0) {
    await sql`DELETE FROM payroll_employee_components WHERE id = ${rowId}::uuid AND employee_id = ${employeeId}::uuid`;
  } else if (rowId) {
    await sql`UPDATE payroll_employee_components SET amount = ${amount} WHERE id = ${rowId}::uuid AND employee_id = ${employeeId}::uuid`;
  } else if (amount !== 0) {
    await sql`
      INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
      VALUES (${employeeId}::uuid, ${componentId}::uuid, ${amount}, ${from}, ${to}, FALSE)
    `;
  }

  await calculatePayrollRun(runId, companyId);
  log.info('Payroll run period amount set', { companyId, runId, employeeId, componentId }, 'payrollRunPeriodInputs');

  const state = await getRunInputs(companyId, runId);
  if (!state) throw new Error('Payroll run vanished under its own lock');
  return state;
}
