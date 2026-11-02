/**
 * The supersede half of a pay-package apply (payPackageService.applyPackageToEmployee), for one component: every
 * assignment of it the apply overlaps is cut to the day before the apply (cancelled outright when it starts on or
 * after it), marked superseded_at (migration 953) and audited, in the apply's transaction under the company lock.
 * Refused (EmployeeComponentRefused, nothing written) when a cut would change what a paid run read.
 */
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { auditComponentChange, type ComponentChangeActor } from './payrollComponentAudit';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import { paidPeriodChanged, periodLabel, windowOf, type PaidPeriod } from './payrollComponentPaidMonths';

const isoDate = (v: unknown): string => fmtDate(v);

/** The calendar day before an ISO date, without a zone. */
function dayBefore(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export interface SupersedeInput {
  companyId: string;
  packageId: string;
  employeeId: string;
  componentId: string;
  effectiveFrom: string;
  paid: PaidPeriod[];
  actor: ComponentChangeActor;
}

/** The number of assignments cut. */
export async function supersedeForPackage(tx: TxSql, input: SupersedeInput): Promise<number> {
  const { companyId, packageId, employeeId, componentId, effectiveFrom, paid, actor } = input;
  const cutTo = dayBefore(effectiveFrom);
  // Supersede every assignment this apply overlaps, not only the
  // open-ended ones. A once-off row is inserted already closed, so an
  // `effective_to IS NULL` predicate would step over the previous apply's
  // row and leave two overlapping windows — getEmployeeComponents returns
  // both and the run pays the component twice.
  const toCut = (await tx`
    SELECT id, effective_from, effective_to, is_recurring, superseded_at, supersede_inferred
      FROM payroll_employee_components
     WHERE employee_id = ${employeeId}::uuid
       AND component_id = ${componentId}::uuid
       AND (effective_to IS NULL OR effective_to >= ${effectiveFrom}::date)
     ORDER BY id FOR UPDATE
  `) as DbRow[];
  // Never cut what a paid run read: that run would no longer agree with the rows (security review, 2026-11-02).
  for (const row of toCut) {
    const changed = paidPeriodChanged(paid, windowOf(row), { ...windowOf(row), to: cutTo });
    if (changed) {
      throw new EmployeeComponentRefused(
        `${periodLabel(changed)} is already paid (approved run), and applying this package from ${effectiveFrom} would cut an `
        + `assignment that run paid (from ${isoDate(row.effective_from)}). Reopen that run first, or apply the package from a later date.`);
    }
  }
  const endResult = (await tx`
    UPDATE payroll_employee_components
       SET effective_to = ${cutTo}::date,
           -- Recorded, not inferred (migration 953): the reader does not pay a once-off this cut.
           superseded_at = now()
     WHERE id = ANY(${toCut.map((row) => String(row.id))}::uuid[])
    RETURNING id, effective_from
  `) as DbRow[];
  for (const row of toCut) {
    await auditComponentChange(tx, companyId, String(row.id), windowOf(row), { ...windowOf(row), to: cutTo }, 'package_supersede', actor);
  }

  // A row starting on or after effectiveFrom is not shortened by the
  // supersede, it is cancelled outright: the new effective_to lands before
  // its effective_from, leaving an empty window the reader never selects.
  // That is the intended outcome and the idiom already used for open-ended
  // rows, but it is silent — a future-dated assignment disappears from a
  // period nobody is looking at yet — so name the rows it happened to.
  const cancelled = endResult.filter(row => isoDate(row.effective_from) >= effectiveFrom);
  if (cancelled.length > 0) {
    log.warn(
      'Pay package apply cancelled assignments it fully overlaps',
      {
        companyId, packageId, employeeId, componentId, effectiveFrom,
        cancelled: cancelled.map(row => ({ id: String(row.id), effectiveFrom: isoDate(row.effective_from) })),
      },
      'payPackageService',
    );
  }
  return endResult.length;
}
