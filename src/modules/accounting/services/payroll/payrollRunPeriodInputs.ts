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
 *   - deductions: not taxable (a taxable one is a retirement contribution, a
 *     donation or warned DEDUCTION_NOT_PAYE_DEDUCTIBLE) and on the explicit list of company-local codes below. No seeded
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
 * under them. A calculation, the write and a second calculation then share one
 * savepoint, and the one refusal that needs the figures (an edit that takes the
 * employee further below nil) is thrown inside it, so the savepoint undoes all of
 * it and the 4xx commits nothing. The stored
 * lines therefore always reflect the inputs, and approve cannot read a stale
 * calculation produced here. Anything else thrown after the write is NOT a
 * PayrollRunInputRefusedError, so the route lets it become a 500 and rolls back.
 *
 * AS EVERY WRITER of payroll_employee_components (#1117): the company lock, the run's own reader (paidByRun), no
 * write at all while the run's journal is in force (assertRunEditable: #1117 counts that month as paid, and an edit
 * or removal would change what it was costed on), refuseAssignmentWrite before an INSERT (a backstop: with that
 * refusal no paid month can reach it), INSERTs naming supersede_inferred = FALSE (mig 953), and an audit row per
 * write in the savepoint, before the recalculation stamps the run (payrollRunRecalcGate reads it; a removal is a
 * 'delete' naming the employee, since its row is gone).
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { log } from '@/lib/logger';
import { formatMoney } from '@/lib/money/formatMoney';
import { TransactionRefusal } from '@/lib/transactionRefusal';
import { normaliseSarsCode } from './payeAnnualPayment';
import { journalInForceOrNull } from './payrollJournalChain';
import { listPayrollRunEmployees } from './payrollEmployeeService';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader, withBoundedLockWait } from './payrollRunLock';
import {
  calculatePayrollRun, getPayrollRun, getPayrollRunLines, type PayrollRunLine, type PayrollRunSummary,
} from './payrollRunService';
import { findOverdrawnLines } from './payrollRunLines';
import { lockPaidRows, monthBounds, readAmounts, type RunPeriod } from './payrollRunPeriodInputsRead';
import { auditComponentChange, type ComponentChangeActor } from './payrollComponentAudit';
import { refuseAssignmentWrite } from './payrollAssignmentWriteGuard';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import { getTaxYear, getTaxYearConfig, UnsupportedTaxYearError } from './taxTables';
import { describePayRunApproval } from './payRunApprovalControl';
import type { DocumentApprovalState } from '@/modules/accounting/types/approval.types';

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
  run: PayrollRunSummary & { lines: PayrollRunLine[]; approval: DocumentApprovalState | null };
  inputs: { components: RunInputComponent[]; employeeIds: string[]; amounts: RunInputAmount[]; recurring: RunInputRecurring[] };
}

type Period = RunPeriod;

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


/** The grid's state: the run with its lines, what it may edit, and what is captured for the run month. Null: not this company's. */
export async function getRunInputs(companyId: string, runId: string): Promise<RunInputsState | null> {
  const run = await getPayrollRun(runId, companyId);
  if (!run) return null;
  const period = { year: run.periodYear, month: run.periodMonth };
  // One after another: under withAuth these share the request's one connection.
  const lines = await getPayrollRunLines(runId, companyId);
  const approval = run.status === 'draft' || run.status === 'calculated'
    ? await describePayRunApproval(companyId, runId) : null;
  const employees = await listPayrollRunEmployees(companyId, period);
  const components = await listEditableComponents(companyId);
  const captured = await readAmounts(companyId, period, components.map((c) => c.id), employees.map((e) => e.id));
  return { run: { ...run, lines, approval }, inputs: { components, employeeIds: employees.map((e) => e.id), ...captured } };
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
  // A reopened run whose journal is still in force: its month was costed (and paid) on these rows, so the grid
  // changes none of them, an insert, an edit or a removal (#1117 treats the month as paid). Reverse it first.
  if (await journalInForceOrNull(companyId, run.journal_entry_id) != null) {
    throw new PayrollRunInputRefusedError(400, 'This run\'s journal is still posted, so the amounts its month was paid on cannot '
      + 'be changed here. Reverse the payroll journal first, then edit the amounts and recalculate.');
  }
}

const centsOf = (rand: number) => Math.round(rand * 100);


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
  actor: ComponentChangeActor,
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
  const component = (await listEditableComponents(companyId)).find((c) => c.id === componentId);
  if (!component) throw new PayrollRunInputRefusedError(400, 'This component cannot be edited on a pay run: use the employee page.');

  // Bounded: a peer editing the employee's components must not pin this request's locks (payrollRunLock.ts).
  const matches = await withBoundedLockWait(runId, (tx) => lockPaidRows(tx, companyId, employeeId, componentId, period));
  const row = matches[0];
  if (matches.length > 1 || (row && row.on_key !== true)) throw new PayrollRunInputRefusedError(409, CONFLICTING_ROWS);
  if (centsOf(row ? Number(row.amount) : 0) !== centsOf(expectedAmount)) throw new PayrollRunInputRefusedError(409, CHANGED);

  const { from, to } = monthBounds(period);
  const rowId = row ? String(row.id) : null;
  await withTransaction(async (tx) => {
    // From a calculation, not the stored line: another writer may have moved the inputs since it was stored.
    await calculatePayrollRun(runId, companyId, actor.userId);
    const shortfallBefore = await shortfallOf(companyId, runId, employeeId);
    const window = { from, to, recurring: false };
    if (rowId && amount === 0) {
      await tx`DELETE FROM payroll_employee_components WHERE id = ${rowId}::uuid AND employee_id = ${employeeId}::uuid`;
      await auditComponentChange(tx, companyId, rowId, window, window, 'run_input_remove', actor, { removed: { employeeId } });
    } else if (rowId) {
      await tx`UPDATE payroll_employee_components SET amount = ${amount} WHERE id = ${rowId}::uuid AND employee_id = ${employeeId}::uuid`;
      await auditComponentChange(tx, companyId, rowId, window, window, 'run_input', actor);
    } else if (amount !== 0) {
      try {
        await refuseAssignmentWrite(tx, companyId, { employeeId, componentId, ...window });
      } catch (err) {
        if (err instanceof EmployeeComponentRefused) throw new PayrollRunInputRefusedError(400, err.message);
        throw err;
      }
      const inserted = (await tx`
        INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring, supersede_inferred)
        VALUES (${employeeId}::uuid, ${componentId}::uuid, ${amount}, ${from}, ${to}, FALSE, FALSE) RETURNING id
      `) as DbRow[];
      await auditComponentChange(tx, companyId, String(inserted[0]!.id), null, window, 'run_input', actor);
    }
    await calculatePayrollRun(runId, companyId, actor.userId);
    // Only what this edit makes worse. Refusing every flagged line would refuse the edits that repair one.
    const shortfall = await shortfallOf(companyId, runId, employeeId);
    if (shortfall > shortfallBefore) {
      const remedy = component.componentType === 'earning' ? 'Enter a higher amount.' : 'Enter a lower amount.';
      throw new PayrollRunInputRefusedError(400, `That would take ${formatMoney(shortfall)} more than this employee's pay. ${remedy}`);
    }
  });
  log.info('Payroll run period amount set', { companyId, runId, employeeId, componentId }, 'payrollRunPeriodInputs');

  const state = await getRunInputs(companyId, runId);
  if (!state) throw new Error('Payroll run vanished under its own lock');
  return state;
}
