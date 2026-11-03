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
import {
  paidPeriodChanged, paidTerminationBaseChanged, periodLabel, windowOf, type PaidPeriod,
} from './payrollComponentPaidMonths';
import { legacyFlips, legacyLeaverSuccessorLost, type Sibling } from './payrollComponentLegacySupersede';

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
  componentType: string;
  effectiveFrom: string;
  paid: PaidPeriod[];
  actor: ComponentChangeActor;
}

/**
 * A pre-953 once-off that a cut row superseded under the old neighbour rule (A 1-14 replaced by B 15-30, B now cut)
 * would be paid again once B is gone, and a pre-953 leaver row whose pre-953 successor the cut removed would be paid
 * in full beside the package's once-off: record their supersede (superseded_at) in the same transaction, as a package
 * apply does for the rows it cuts itself (953 review, review of 485fc14f2).
 */
async function recordRevivedLegacyOnceOffs(
  tx: TxSql, all: DbRow[], cutIds: Set<string>, cutTo: string, companyId: string, actor: ComponentChangeActor,
): Promise<void> {
  const before: Sibling[] = all.map((row) => ({ ...windowOf(row), id: String(row.id) }));
  const after = before.map((r) => (cutIds.has(r.id) ? { ...r, to: cutTo, supersededAt: Date.now() } : r));
  const revived = legacyFlips(before, after).filter((f) => f.paidAgain).map((f) => f.row);
  // And a pre-953 leaver row whose pre-953 successor this cut or voided (S to the 29th, O from the 30th, the package
  // re-applied from the 30th): recorded, the leaver rule takes the package's own row as its successor (review 485fc14f2).
  for (const row of [...revived, ...legacyLeaverSuccessorLost(before, after)]) {
    await tx`UPDATE payroll_employee_components SET superseded_at = clock_timestamp() WHERE id = ${row.id}::uuid AND superseded_at IS NULL`;
    await auditComponentChange(tx, companyId, row.id, row, row, 'package_supersede', actor);
  }
}

/** The number of assignments cut. */
export async function supersedeForPackage(tx: TxSql, input: SupersedeInput): Promise<number> {
  const { companyId, packageId, employeeId, componentId, componentType, effectiveFrom, paid, actor } = input;
  const cutTo = dayBefore(effectiveFrom);
  // Supersede every assignment this apply overlaps, not only the
  // open-ended ones. A once-off row is inserted already closed, so an
  // `effective_to IS NULL` predicate would step over the previous apply's
  // row and leave two overlapping windows — getEmployeeComponents returns
  // both and the run pays the component twice.
  const all = (await tx`
    SELECT id, effective_from, effective_to, is_recurring, superseded_at, supersede_inferred,
           (SELECT end_date FROM payroll_employees WHERE id = employee_id) AS employee_end
      FROM payroll_employee_components
     WHERE employee_id = ${employeeId}::uuid
       AND component_id = ${componentId}::uuid
     ORDER BY id FOR UPDATE
  `) as DbRow[];
  const toCut = all.filter((row) => row.effective_to == null || isoDate(row.effective_to) >= effectiveFrom);
  // Never cut what a paid run read: that run would no longer agree with the rows (security review, 2026-11-02).
  for (const row of toCut) {
    const before = windowOf(row);
    const after = { ...before, to: cutTo };
    const changed = paidPeriodChanged(paid, before, after)
      ?? (componentType === 'earning' ? paidTerminationBaseChanged(paid, before, after) : null);
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
           superseded_at = clock_timestamp()
     WHERE id = ANY(${toCut.map((row) => String(row.id))}::uuid[])
    RETURNING id, effective_from
  `) as DbRow[];
  for (const row of toCut) {
    await auditComponentChange(tx, companyId, String(row.id), windowOf(row), { ...windowOf(row), to: cutTo }, 'package_supersede', actor);
  }
  await recordRevivedLegacyOnceOffs(tx, all, new Set(toCut.map((row) => String(row.id))), cutTo, companyId, actor);

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
