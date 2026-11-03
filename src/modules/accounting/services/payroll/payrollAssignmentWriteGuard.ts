/**
 * What a writer that INSERTs an assignment refuses before it writes (assign, batch post, package apply), under the
 * company's payroll-approval lock: a once-off spanning months; a row dated in a month the company's paid runs paid
 * (payrollOnceOffGuard); and, for a recurring row, a live row of the same employee and component it overlaps (both
 * would be paid), as Edit dates refuses it. The siblings are read FOR UPDATE. Batch post reads the paid months once
 * and passes them in (`paid`), and names the employee in a refusal (`named`: a batch holds many).
 * Package apply cuts the overlapping rows first (payPackageSupersede), so it skips the overlap (`overlap: false`).
 */
import type { DbRow, TxSql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import type { PaidPeriod } from './payrollComponentPaidMonths';
import { refuseOnceOffInPaidMonth, refuseOnceOffSpan, refuseRecurringInPaidMonth } from './payrollOnceOffGuard';

export interface AssignmentWrite { employeeId: string; componentId: string; from: string; to: string | null; recurring: boolean }
export interface WriteGuardOptions { paid?: PaidPeriod[]; named?: boolean; overlap?: boolean }

async function refuseOverlap(tx: TxSql, a: AssignmentWrite): Promise<void> {
  const siblings = (await tx`
    SELECT effective_from, effective_to FROM payroll_employee_components
     WHERE employee_id = ${a.employeeId}::uuid AND component_id = ${a.componentId}::uuid
     ORDER BY id FOR UPDATE
  `) as DbRow[];
  for (const r of siblings) {
    const from = fmtDate(r.effective_from);
    const to = r.effective_to ? fmtDate(r.effective_to) : null;
    const live = to === null || to >= from;
    if (live && from <= (a.to ?? '9999-12-31') && (to === null || to >= a.from)) {
      throw new EmployeeComponentRefused(`These dates overlap the employee's other assignment of this component (${from} to ${to ?? 'open-ended'}): `
        + 'both would be paid. Change or end that one first.');
    }
  }
}

export async function refuseAssignmentWrite(
  tx: TxSql, companyId: string, a: AssignmentWrite, opts: WriteGuardOptions = {},
): Promise<void> {
  try {
    if (!a.recurring) {
      refuseOnceOffSpan(a.from, a.to);
      await refuseOnceOffInPaidMonth(tx, companyId, a.from, a.to, null, opts.paid);
      return;
    }
    await refuseRecurringInPaidMonth(tx, companyId, null, { from: a.from, to: a.to }, opts.paid);
    if (opts.overlap !== false) await refuseOverlap(tx, a);
  } catch (err) {
    if (!opts.named || !(err instanceof EmployeeComponentRefused)) throw err;
    const row = (await tx`
      SELECT employee_number FROM payroll_employees WHERE id = ${a.employeeId}::uuid AND company_id = ${companyId}::uuid
    `) as DbRow[];
    throw new EmployeeComponentRefused(`Employee ${String(row[0]?.employee_number ?? a.employeeId)}: ${err.message}`);
  }
}
