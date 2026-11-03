/**
 * The supersede half of a pay-package apply (payPackageService.applyPackageToEmployee), for one component: every
 * assignment of it the apply overlaps is cut to the day before the apply (cancelled outright when it starts on or
 * after it), marked superseded_at (migration 953) and audited, in the apply's transaction under the company lock.
 * Refused (EmployeeComponentRefused, nothing written) when a cut would change what a paid run read.
 */
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { endOfMonthIso } from './leaveAccrualService';
import { auditComponentChange, type ComponentChangeActor } from './payrollComponentAudit';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import { paidNote, paidPeriodChanged, paidRemedy, periodLabel, windowOf, type PaidPeriod } from './payrollComponentPaidMonths';
import { legacyFlips, legacyLeaverSuccessorLost, type Sibling } from './payrollComponentLegacySupersede';

const isoDate = (v: unknown): string => fmtDate(v);

/** The last day of an ISO date's month: the close the package gives its own once-off rows. */
const endOfMonth = (iso: string): string => endOfMonthIso(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)));

/**
 * The once-offs among `ids` the package wrote, by provenance: the audit entry that created the row says package_assign
 * (and, since it records the package, this package's id). A different package's once-off, or one entered by hand
 * (assign, batch), is not. A row with no audit entry (written before this release) falls back to its shape.
 */
async function ownOnceOffs(
  tx: TxSql, companyId: string, packageId: string, componentId: string, rows: DbRow[],
): Promise<Set<string>> {
  // The row's FIRST entry is the one that created it; a later one (a forged package_assign) is not read.
  const entries = (await tx`
    SELECT DISTINCT ON (entity_id) entity_id::text AS id, changes->'metadata'->>'kind' AS kind, changes->'metadata'->>'packageId' AS package_id
      FROM audit_log
     WHERE company_id = ${companyId}::uuid AND entity_type = 'payroll_employee_component' AND action = 'create'
       AND entity_id = ANY(${rows.map((r) => String(r.id))}::uuid[])
     ORDER BY entity_id, created_at, id
  `) as DbRow[];
  const byId = new Map(entries.map((e) => [String(e.id), e]));
  const ownAmounts = await ownOnceOffAmounts(tx, packageId, componentId);
  const own = new Set<string>();
  for (const row of rows) {
    const entry = byId.get(String(row.id));
    const legacyShape = ownAmounts.has(Number(row.amount)) && isoDate(row.effective_to) === endOfMonth(isoDate(row.effective_from));
    // An entry that records no package vouches for nothing about which one: the shape decides, as for a row with no entry.
    if (entry ? entry.kind === 'package_assign' && (entry.package_id ? entry.package_id === packageId : legacyShape) : legacyShape) own.add(String(row.id));
  }
  return own;
}

/** The amounts of this package's once-off lines for the component: what its own earlier rows were written with. */
async function ownOnceOffAmounts(tx: TxSql, packageId: string, componentId: string): Promise<Set<number>> {
  const lines = (await tx`
    SELECT amount FROM pay_package_components
     WHERE package_id = ${packageId}::uuid AND component_id = ${componentId}::uuid AND is_recurring = false
  `) as DbRow[];
  return new Set(lines.map((l) => Number(l.amount)));
}

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
  const { companyId, packageId, employeeId, componentId, effectiveFrom, paid, actor } = input;
  const cutTo = dayBefore(effectiveFrom);
  // Supersede every assignment this apply overlaps, not only the
  // open-ended ones. A once-off row is inserted already closed, so an
  // `effective_to IS NULL` predicate would step over the previous apply's
  // row and leave two overlapping windows — getEmployeeComponents returns
  // both and the run pays the component twice.
  const all = (await tx`
    SELECT id, amount, effective_from, effective_to, is_recurring, superseded_at, supersede_inferred,
           (SELECT end_date FROM payroll_employees WHERE id = employee_id) AS employee_end
      FROM payroll_employee_components
     WHERE employee_id = ${employeeId}::uuid
       AND component_id = ${componentId}::uuid
     ORDER BY id FOR UPDATE
  `) as DbRow[];
  const overlapped = all.filter((row) => row.effective_to == null || isoDate(row.effective_to) >= effectiveFrom);
  // A recurring row is the package's to replace. A once-off is only if the package wrote it (a re-apply); one entered
  // by hand (a back-pay) is not: the apply is refused, with nothing written, rather than cancel it silently.
  // Only live, un-superseded once-offs are judged: a voided one (cancelled, End refuses it) and one an earlier apply
  // already replaced are paid by nobody, so they cannot be cancelled again.
  const liveOnceOffs = overlapped.filter((row) => row.is_recurring === false && row.superseded_at == null
    && (row.effective_to == null || isoDate(row.effective_to) >= isoDate(row.effective_from)));
  const own = await ownOnceOffs(tx, companyId, packageId, componentId, liveOnceOffs);
  const foreign = liveOnceOffs.filter((row) => !own.has(String(row.id)));
  const foreignIds = new Set(foreign.map((row) => String(row.id)));
  const toCut = overlapped;
  // Never cut what a paid run read: that run would no longer agree with the rows (security review, 2026-11-02). Checked
  // first: a month already paid is the stronger reason, and its remedy leads.
  for (const row of toCut) {
    const changed = paidPeriodChanged(paid, windowOf(row), { ...windowOf(row), to: cutTo });
    if (changed) {
      if (foreignIds.has(String(row.id))) {
        throw new EmployeeComponentRefused(
          `${periodLabel(changed)} is already paid ${paidNote(changed)}, and applying this package from ${effectiveFrom} would cancel a once-off this package did not write `
          + `(from ${isoDate(row.effective_from)}) that run paid. Apply the package from a later date; or, to keep this date, ${paidRemedy(changed)} and then end or move that once-off.`);
      }
      throw new EmployeeComponentRefused(
        `${periodLabel(changed)} is already paid ${paidNote(changed)}, and applying this package from ${effectiveFrom} would cut an `
        + `assignment that run paid (from ${isoDate(row.effective_from)}). ${paidRemedy(changed)}, or apply the package from a later date.`);
    }
  }
  if (foreign.length > 0) {
    const named = foreign.map((row) => `${isoDate(row.effective_from)} to ${row.effective_to ? isoDate(row.effective_to) : 'open-ended'}, amount ${Number(row.amount).toFixed(2)}`);
    throw new EmployeeComponentRefused(
      `Applying this package from ${effectiveFrom} would cancel ${foreign.length === 1 ? 'a once-off' : 'once-offs'} this package did not write `
      + `(entered by hand, posted by a batch, or written by another package) on this component: ${named.join(', ')}. End or move ${foreign.length === 1 ? 'it' : 'them'} first, or apply the package from a later date.`);
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
