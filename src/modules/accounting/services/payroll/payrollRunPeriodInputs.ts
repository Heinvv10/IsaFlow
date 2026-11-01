/**
 * Once-off period amounts for the pay-run review grid (master plan wave 3, R;
 * decision 7). The row key is (employee, component, is_recurring = false, the
 * run month's first and last day). The grid edits the one row that matches,
 * whoever wrote it (a batch, MCP, the grid). A once-off row the run pays that is
 * NOT exactly on the key (overtime captured on the 15th runs 15th to month end),
 * or more than one, is a conflict: the cell links to the employee page and a PUT
 * answers 409, because typing beside such a row would pay twice.
 *
 * WHICH COMPONENTS. Regular pay and deductions with no tax effect, nothing else:
 *   - earnings: 3601 salary, 3606 commission, 3607 overtime, flagged taxable.
 *     3605 and the 39xx lump sums are taxed by other rules (payeTreatment).
 *   - deductions: not taxable (the calculator takes a taxable deduction off PAYE
 *     income) and on the explicit list of company-local codes below. No seeded
 *     company has one, so by default the grid has no deduction column. A local
 *     code fails IRP5 readiness (IRP5_UNKNOWN_CODE) at year end, which is why the
 *     list is opt-in. Every four-digit code is a SARS code with a meaning beyond
 *     the payslip: the retirement and medical families move PAYE or a certificate
 *     field, and any 39xx in a run's breakdown, even on a deduction, trips the
 *     approval gate's lump_sum_without_directive. LOAN belongs to the loan
 *     service, which pairs it with a balance.
 *   - employer_contribution never: the calculator does not process it.
 *
 * ORDER (rule 9; a 4xx commits). setRunPeriodAmount takes the locks in the order
 * of every payroll-run writer (payrollRunLock.ts) and judges everything it can
 * under them. The write and the recalculation then share one savepoint, and the
 * one refusal that needs the new figures (deductions exceeding pay) is thrown
 * inside it, so the savepoint undoes both and the 4xx commits nothing. The stored
 * lines therefore always reflect the inputs, and approve cannot read a stale
 * calculation produced here. Anything else thrown after the write is NOT a
 * PayrollRunInputRefusedError, so the route lets it become a 500 and rolls back.
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { log } from '@/lib/logger';
import { TransactionRefusal } from '@/lib/transactionRefusal';
import { endOfMonthIso } from './leaveAccrualService';
import { normaliseSarsCode } from './payeAnnualPayment';
import { journalInForceOrNull } from './payrollJournalChain';
import { listPayrollRunEmployees } from './payrollEmployeeService';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader, withBoundedLockWait } from './payrollRunLock';
import { PayrollRunJournalPostedError, runHasLoanWork } from './payrollRunLoanApplication';
import {
  calculatePayrollRun, getPayrollRun, getPayrollRunLines, type PayrollRunLine, type PayrollRunSummary,
} from './payrollRunService';
import { findOverdrawnLines } from './payrollRunLines';
import { getTaxYear, getTaxYearConfig, UnsupportedTaxYearError } from './taxTables';

const EDITABLE_EARNING_CODES: ReadonlySet<string> = new Set(['3601', '3606', '3607']);
/** Company-local codes only, never four digits (see the top of this file). Upper case. */
export const EDITABLE_LOCAL_DEDUCTION_CODES: ReadonlySet<string> = new Set(['UNION']);
const EDITABLE_STATUSES: ReadonlySet<string> = new Set(['draft', 'calculated']);
/** NUMERIC(14,2). */
const MAX_AMOUNT = 999_999_999_999.99;
const CONFLICTING_ROWS = 'Edit this on the employee page: this month already pays an amount for this component that this cell cannot show.';
const CHANGED = 'Someone else changed this amount. The stored amount is back in the cell: check it, then enter yours again.';

export interface EditableComponentFacts {
  sarsSourceCode: string;
  componentType: string;
  isTaxable: boolean;
}

export function isEditableRunComponent(c: EditableComponentFacts): boolean {
  const code = normaliseSarsCode(c.sarsSourceCode);
  if (c.componentType === 'earning') return c.isTaxable && EDITABLE_EARNING_CODES.has(code);
  if (c.componentType === 'deduction') return !c.isTaxable && EDITABLE_LOCAL_DEDUCTION_CODES.has(code.toUpperCase());
  return false;
}

/** Raised before the first write, or inside the savepoint that undoes it, so answering it as a 4xx commits nothing. */
export class PayrollRunInputRefusedError extends TransactionRefusal {
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
  /** Null on a conflict: the grid cannot say which one a cell would be. */
  amount: number | null;
  conflict: boolean;
}

/** What the run pays every month on this component, shown beside the once-off cell. */
export interface RunInputRecurring {
  employeeId: string;
  componentId: string;
  amount: number;
}

export interface RunInputsState {
  run: PayrollRunSummary & { lines: PayrollRunLine[] };
  inputs: { components: RunInputComponent[]; employeeIds: string[]; amounts: RunInputAmount[]; recurring: RunInputRecurring[] };
}

interface Period { year: number; month: number }

const monthBounds = ({ year, month }: Period) => ({
  from: `${year}-${String(month).padStart(2, '0')}-01`,
  to: endOfMonthIso(year, month),
});

/** The date getEmployeeComponents reads a run's rows at: calculatePayrollRun's periodDate, as that reader turns it into a date. */
const paidOn = ({ year, month }: Period) => new Date(year, month - 1, 28).toISOString().split('T')[0]!;

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

async function readAmounts(companyId: string, period: Period, componentIds: string[]) {
  const { from, to } = monthBounds(period);
  const payDay = paidOn(period);
  const rows = (await sql`
    SELECT pec.employee_id, pec.component_id,
           COUNT(*) FILTER (WHERE NOT pec.is_recurring)::int AS matches,
           COUNT(*) FILTER (WHERE NOT pec.is_recurring AND pec.effective_from = ${from}::date AND pec.effective_to = ${to}::date)::int AS on_key,
           MIN(pec.amount) FILTER (WHERE NOT pec.is_recurring)::float8 AS amount,
           COALESCE(SUM(pec.amount) FILTER (WHERE pec.is_recurring), 0)::float8 AS recurring
    FROM payroll_employee_components pec
    JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = ${companyId}::uuid
    WHERE pec.component_id = ANY(${componentIds}::uuid[])
      AND pec.effective_from <= ${payDay}::date AND (pec.effective_to IS NULL OR pec.effective_to >= ${payDay}::date)
    GROUP BY pec.employee_id, pec.component_id
  `) as DbRow[];
  const key = (r: DbRow) => ({ employeeId: String(r.employee_id), componentId: String(r.component_id) });
  const amounts: RunInputAmount[] = rows.filter((r) => Number(r.matches) > 0).map((r) => {
    const conflict = Number(r.matches) !== 1 || Number(r.on_key) !== 1;
    return { ...key(r), amount: conflict ? null : Number(r.amount), conflict };
  });
  const recurring: RunInputRecurring[] = rows.filter((r) => Number(r.recurring) !== 0).map((r) => ({ ...key(r), amount: Number(r.recurring) }));
  return { amounts, recurring };
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
  const captured = await readAmounts(companyId, period, components.map((c) => c.id));
  return { run: { ...run, lines }, inputs: { components, employeeIds: employees.map((e) => e.id), ...captured } };
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

const centsOf = (rand: number) => Math.round(rand * 100);

/** The once-off rows this run pays for the cell, locked, with whether each sits exactly on the row key. */
async function lockPaidRows(tx: TxSql, companyId: string, employeeId: string, componentId: string, period: Period): Promise<DbRow[]> {
  const { from, to } = monthBounds(period);
  const payDay = paidOn(period);
  return (await tx`
    SELECT pec.id, pec.amount, (pec.effective_from = ${from}::date AND pec.effective_to = ${to}::date) AS on_key
    FROM payroll_employee_components pec
    JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = ${companyId}::uuid
    WHERE pec.employee_id = ${employeeId}::uuid AND pec.component_id = ${componentId}::uuid
      AND pec.is_recurring = FALSE
      AND pec.effective_from <= ${payDay}::date AND (pec.effective_to IS NULL OR pec.effective_to >= ${payDay}::date)
    FOR UPDATE OF pec
  `) as DbRow[];
}

const shortfallOf = async (companyId: string, runId: string, employeeId: string) =>
  (await findOverdrawnLines(companyId, runId)).find((l) => l.employeeId === employeeId)?.shortfall ?? 0;

/**
 * `expectedAmount` is what the cell last showed, 0 when empty. It must match what is stored, or a change
 * someone else made since is overwritten unseen.
 */
export async function setRunPeriodAmount(
  companyId: string,
  runId: string,
  employeeId: string,
  componentId: string,
  amount: number,
  expectedAmount: number,
): Promise<RunInputsState> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
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

  // Bounded: a peer editing the employee's components must not pin this request's locks (payrollRunLock.ts).
  const matches = await withBoundedLockWait(runId, (tx) => lockPaidRows(tx, companyId, employeeId, componentId, period));
  const row = matches[0];
  if (matches.length > 1 || (row && row.on_key !== true)) throw new PayrollRunInputRefusedError(409, CONFLICTING_ROWS);
  if (centsOf(row ? Number(row.amount) : 0) !== centsOf(expectedAmount)) throw new PayrollRunInputRefusedError(409, CHANGED);

  const { from, to } = monthBounds(period);
  const rowId = row ? String(row.id) : null;
  const shortfallBefore = await shortfallOf(companyId, runId, employeeId);
  await withTransaction(async (tx) => {
    if (rowId && amount === 0) {
      await tx`DELETE FROM payroll_employee_components WHERE id = ${rowId}::uuid AND employee_id = ${employeeId}::uuid`;
    } else if (rowId) {
      await tx`UPDATE payroll_employee_components SET amount = ${amount} WHERE id = ${rowId}::uuid AND employee_id = ${employeeId}::uuid`;
    } else if (amount !== 0) {
      await tx`
        INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
        VALUES (${employeeId}::uuid, ${componentId}::uuid, ${amount}, ${from}, ${to}, FALSE)
      `;
    }
    await calculatePayrollRun(runId, companyId);
    // Only what this edit makes worse. Refusing every flagged line would refuse the edits that repair one.
    const shortfall = await shortfallOf(companyId, runId, employeeId);
    if (shortfall > shortfallBefore) {
      throw new PayrollRunInputRefusedError(400, `That would take R ${shortfall.toFixed(2)} more than this employee's pay. Enter a lower amount.`);
    }
  });
  log.info('Payroll run period amount set', { companyId, runId, employeeId, componentId }, 'payrollRunPeriodInputs');

  const state = await getRunInputs(companyId, runId);
  if (!state) throw new Error('Payroll run vanished under its own lock');
  return state;
}
