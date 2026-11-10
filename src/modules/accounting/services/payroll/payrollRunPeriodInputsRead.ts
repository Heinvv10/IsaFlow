/**
 * The pay-run grid's reads (payrollRunPeriodInputs): what the run pays each employee for the grid's components,
 * through the run's own reader (getEmployeeComponents on payrollRunReadDate, the period's last day), never a window
 * of the grid's own, so a cell conflicts exactly when the run pays a row it cannot show (merge with #1117, which
 * moved the reader to the last day and pays a once-off dated in the month whatever its end).
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { endOfMonthIso } from './leaveAccrualService';
import { getEmployeeComponents } from './payrollComponentService';
import { payrollRunReadDate } from './payrollRunReadDate';
import type { RunInputAmount, RunInputRecurring } from './payrollRunPeriodInputs';

export interface RunPeriod { year: number; month: number }

/** The row key's dates: the run month's first and last day. */
export const monthBounds = ({ year, month }: RunPeriod) => ({
  from: `${year}-${String(month).padStart(2, '0')}-01`,
  to: endOfMonthIso(year, month),
});

type Period = RunPeriod;

/**
 * What the run pays each employee for these components: the run's own reader (getEmployeeComponents on its read day,
 * payrollRunReadDate), never a window of the grid's own, so a cell conflicts exactly when the run pays a row it cannot show.
 * One employee after another: under withAuth these share the request's one connection.
 */
async function paidByRun(companyId: string, employeeIds: string[], period: Period, componentIds: string[]) {
  const wanted = new Set(componentIds);
  const paid: Array<{ employeeId: string; componentId: string; id: string; recurring: boolean; amount: number; quantity: number | null }> = [];
  for (const employeeId of employeeIds) {
    for (const c of await getEmployeeComponents(employeeId, companyId, payrollRunReadDate(period))) {
      if (wanted.has(c.component.id) && c.assignmentId) {
        paid.push({ employeeId, componentId: c.component.id, id: c.assignmentId, recurring: c.isRecurring !== false, amount: c.amount, quantity: c.quantity ?? null });
      }
    }
  }
  return paid;
}

export async function readAmounts(companyId: string, period: Period, componentIds: string[], employeeIds: string[]) {
  const { from, to } = monthBounds(period);
  const paid = await paidByRun(companyId, employeeIds, period, componentIds);
  const onceIds = paid.filter((p) => !p.recurring).map((p) => p.id);
  const keyed = new Set(((await sql`
    SELECT pec.id FROM payroll_employee_components pec
    JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = ${companyId}::uuid
    WHERE pec.id = ANY(${onceIds}::uuid[]) AND pec.effective_from = ${from}::date AND pec.effective_to = ${to}::date
  `) as DbRow[]).map((r) => String(r.id)));
  const cells = new Map<string, { employeeId: string; componentId: string; once: typeof paid; recurring: number }>();
  for (const p of paid) {
    const k = `${p.employeeId}|${p.componentId}`;
    const cell = cells.get(k) ?? { employeeId: p.employeeId, componentId: p.componentId, once: [], recurring: 0 };
    if (p.recurring) cell.recurring += p.amount; else cell.once.push(p);
    cells.set(k, cell);
  }
  // One entry per quantity row the run pays, recurring or once-off, BEFORE a cell with several rows is nulled as a conflict: the very set the
  // write path (setRunHours) counts, so the grid and the write cannot disagree about duplicates.
  const quantityRows = paid.filter((p) => p.quantity != null).map((p) => ({ employeeId: p.employeeId, componentId: p.componentId }));
  const amounts: RunInputAmount[] = [...cells.values()].filter((c) => c.once.length > 0).map((c) => {
    const conflict = c.once.length !== 1 || !keyed.has(c.once[0]!.id);
    return { employeeId: c.employeeId, componentId: c.componentId, amount: conflict ? null : c.once[0]!.amount, conflict, quantity: conflict ? null : c.once[0]!.quantity };
  });
  const recurring: RunInputRecurring[] = [...cells.values()].filter((c) => c.recurring !== 0)
    .map((c) => ({ employeeId: c.employeeId, componentId: c.componentId, amount: c.recurring }));
  return { amounts, recurring, quantityRows };
}

/** The once-off rows this run pays for the cell (its own reader: paidByRun), locked, with whether each sits on the row key. */
export async function lockPaidRows(tx: TxSql, companyId: string, employeeId: string, componentId: string, period: Period): Promise<DbRow[]> {
  const { from, to } = monthBounds(period);
  const ids = (await paidByRun(companyId, [employeeId], period, [componentId])).filter((p) => !p.recurring).map((p) => p.id);
  return (await tx`
    SELECT pec.id, pec.amount, pec.quantity, (pec.effective_from = ${from}::date AND pec.effective_to = ${to}::date) AS on_key
    FROM payroll_employee_components pec
    JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = ${companyId}::uuid
    WHERE pec.id = ANY(${ids}::uuid[])
    FOR UPDATE OF pec
  `) as DbRow[];
}
