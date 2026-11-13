/**
 * The write of one once-off row of the pay-run grid (amount, or HD's hours and days), moved out of payrollRunPeriodInputs.ts.
 */
import { judgeFundAssignment } from './payrollComponentRfi';
import { withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { auditComponentChange, type ComponentChangeActor } from './payrollComponentAudit';
import { refuseAssignmentWrite } from './payrollAssignmentWriteGuard';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import { PayrollRunInputRefusedError } from './payrollRunInputRefused';
import { findOverdrawnLines } from './payrollRunLines';
import { calculatePayrollRun } from './payrollRunService';
import { monthBounds, type RunPeriod } from './payrollRunPeriodInputsRead';
import type { QuantityUnit } from './payrollTypes';

const shortfallOf = async (companyId: string, runId: string, employeeId: string) =>
  (await findOverdrawnLines(companyId, runId)).find((l) => l.employeeId === employeeId)?.shortfall ?? 0;

export interface RunRowWrite {
  companyId: string;
  runId: string;
  employeeId: string;
  componentId: string;
  componentType: 'earning' | 'deduction';
  period: RunPeriod;
  /** The once-off row on the run month's key the caller locked, null when there is none yet. */
  rowId: string | null;
  amount: number;
  /** Delete the row (a plain amount of 0, or hours cleared). A nil entry of hours is NOT a clear: it is stored, at amount 0. */
  clear: boolean;
  /** HD: the hours or days the amount is for; null for a plain amount. */
  quantity: { value: number; unit: QuantityUnit } | null;
  actor: ComponentChangeActor;
}

/**
 * The write of the once-off row (insert, update or, at an amount of 0, delete), between two calculations in one
 * savepoint: the one refusal that needs the figures is thrown inside it, so the savepoint undoes all of it.
 */
export async function writeRunRow(w: RunRowWrite): Promise<void> {
  const { companyId, runId, employeeId, componentId, rowId, amount, actor } = w;
  const clear = w.clear;
  const { from, to } = monthBounds(w.period);
  const quantity = w.quantity?.value ?? null;
  const unit = w.quantity?.unit ?? null;
  await withTransaction(async (tx) => {
    // From a calculation, not the stored line: another writer may have moved the inputs since it was stored.
    await calculatePayrollRun(runId, companyId, actor.userId);
    const shortfallBefore = await shortfallOf(companyId, runId, employeeId);
    const window = { from, to, recurring: false };
    if (rowId && clear) {
      await tx`DELETE FROM payroll_employee_components WHERE id = ${rowId}::uuid AND employee_id = ${employeeId}::uuid`;
      await auditComponentChange(tx, companyId, rowId, window, window, 'run_input_remove', actor, { removed: { employeeId } });
    } else if (rowId) {
      // RF: a percent_of_rfi row's amount is the run's to cost (its CHECK holds amount at 0): a 400, never the CHECK's 500.
      const updated = (await tx`UPDATE payroll_employee_components SET amount = ${amount}, quantity = ${quantity}::numeric, quantity_unit = ${unit}
        WHERE id = ${rowId}::uuid AND employee_id = ${employeeId}::uuid AND percent_of_rfi IS NULL RETURNING id`) as DbRow[];
      if (updated.length === 0) {
        throw new PayrollRunInputRefusedError(400, 'This amount is a percentage of retirement-funding income, costed by the run: change the percentage on the employee profile.');
      }
      await auditComponentChange(tx, companyId, rowId, window, window, 'run_input', actor);
    } else if (!clear) {
      try {
        await judgeFundAssignment(tx, companyId, componentId);
        await refuseAssignmentWrite(tx, companyId, { employeeId, componentId, ...window });
      } catch (err) {
        if (err instanceof EmployeeComponentRefused) throw new PayrollRunInputRefusedError(400, err.message);
        throw err;
      }
      const inserted = (await tx`
        INSERT INTO payroll_employee_components (employee_id, component_id, amount, quantity, quantity_unit, effective_from, effective_to, is_recurring, supersede_inferred)
        VALUES (${employeeId}::uuid, ${componentId}::uuid, ${amount}, ${quantity}::numeric, ${unit}, ${from}, ${to}, FALSE, FALSE) RETURNING id
      `) as DbRow[];
      await auditComponentChange(tx, companyId, String(inserted[0]!.id), null, window, 'run_input', actor);
    }
    await calculatePayrollRun(runId, companyId, actor.userId);
    // Only what this edit makes worse. Refusing every flagged line would refuse the edits that repair one.
    const shortfall = await shortfallOf(companyId, runId, employeeId);
    if (shortfall > shortfallBefore) {
      const remedy = w.componentType === 'earning' ? 'Enter a higher amount.' : 'Enter a lower amount.';
      throw new PayrollRunInputRefusedError(400, `That would take ${formatMoney(shortfall)} more than this employee's pay. ${remedy}`);
    }
  });
}
