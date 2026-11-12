/**
 * The supersede half of a pay-package apply (payPackageService.applyPackageToEmployee), for one component: every
 * assignment of it the apply overlaps is cut to the day before the apply (cancelled outright when it starts on or
 * after it), marked superseded_at (migration 953) and audited, in the apply's transaction under the company lock.
 * Refused (EmployeeComponentRefused, nothing written) when a cut would change what a paid run read.
 */
import { formatPercent } from './rfi';
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { endOfMonthIso } from './leaveAccrualService';
import { auditComponentChange, type ComponentChangeActor } from './payrollComponentAudit';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import { paidNote, paidPeriodChanged, paidPeriodsOf, paidRemedy, paidRemedyInline, periodLabel, windowOf, type PaidPeriod } from './payrollComponentPaidMonths';
import { legacyFlips, legacyLeaverSuccessorLost, type Sibling } from './payrollComponentLegacySupersede';

const isoDate = (v: unknown): string => fmtDate(v);

/** The last day of an ISO date's month: the close the package gives its own once-off rows. */
const endOfMonth = (iso: string): string => endOfMonthIso(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)));

/**
 * The once-offs among `ids` the package wrote, by provenance: the audit entry that created the row says package_assign
 * (and, since it records the package, this package's id). A different package's once-off, or one entered by hand
 * (assign, batch), is not. A row with no audit entry is ambiguous and therefore not owned.
 */
async function ownOnceOffs(
  tx: TxSql, companyId: string, packageId: string, componentId: string, rows: DbRow[], maybeOwn: Set<string> = new Set(),
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
    // Own only by a recorded origin: this package's id on the creation entry. A row with no entry (written before the
    // origin was recorded) is never taken as own (fail closed), but when its shape matches the package's line it is
    // flagged as possibly its own, so the refusal can say so (maybeOwn).
    if (entry?.kind === 'package_assign' && entry.package_id === packageId) own.add(String(row.id));
    else if (!entry && legacyShape) maybeOwn.add(String(row.id));
  }
  return own;
}

/** "2026-09" of an ISO date. */
const monthOf = (iso: string): string => iso.slice(0, 7);

/** A once-off the package would refuse that has no recorded origin and matches the package's line. */
const isAmbiguous = (row: DbRow): boolean => row.maybe_own === true;

/**
 * The advice for once-offs with no recorded origin that match the package's own line: they may be the package's once-off
 * from an earlier apply (written before origins were recorded). Only remedies that work step by step are offered:
 *   - "end it, then apply from {effectiveFrom}" only when every such row can be ended (no pre-953 neighbour it would
 *     revive, `end_ok`), {effectiveFrom}'s month is not paid company-wide, the refusal is not for a paid month, and every
 *     refused row is of this kind (a recorded foreign row would still block);
 *   - otherwise only the {applyFrom} route, whose warning is that it pays the package's once-off again if it IS the package's.
 */
function unrecordedOriginAdvice(
  set: DbRow[], effectiveFrom: string, applyFrom: string | null, effectiveFromPaid: boolean, inPaidMonth: boolean,
): string {
  const ambiguous = set.filter(isAmbiguous);
  const mixed = set.some((row) => !isAmbiguous(row));
  const warn = `${ambiguous.length === 1 ? 'A once-off has' : 'Once-offs have'} no recorded origin and may be this package's own once-off from an earlier apply`;
  const again = applyFrom ? ` (applying from ${applyFrom} when it IS the package's pays its once-off again in ${monthOf(applyFrom)})` : '';
  const later = applyFrom ?? 'a later date';
  const canEnd = !mixed && !inPaidMonth && !effectiveFromPaid && ambiguous.every((row) => row.end_ok === true);
  if (canEnd) {
    return `${warn}. If it is the package's: end it, then apply from ${effectiveFrom}. If it was entered by hand: apply from ${later}${again}.`;
  }
  if (mixed) {
    const list = (rows: DbRow[]) => rows.map((row) => `${isoDate(row.effective_from)} to ${row.effective_to ? isoDate(row.effective_to) : 'open-ended'}`).join(', ');
    return `${warn}: ${list(ambiguous)}. Others on this package's components were not written by this package: ${list(set.filter((row) => !isAmbiguous(row)))}. `
      + `Apply the package from ${later}${again}.`;
  }
  return `${warn}. Apply the package from ${later}${again}.`;
}

/**
 * The date to apply the package from instead, named only where it is provably followable: after EVERY once-off the apply
 * would refuse (so none is cancelled), and after the latest company-paid month on or after the earliest of them (so no
 * paid month is reached, whatever the package holds). That is the first day of the month after that paid month, or the
 * day after the last of those once-offs ends if that is later (it then falls in an unpaid month, being after every
 * paid one). Null when one is open-ended (no day after it).
 */
function applyFromAfter(rows: DbRow[], paid: PaidPeriod[]): string | null {
  if (rows.some((row) => row.effective_to == null)) return null;
  const idx = (y: number, m: number) => y * 12 + m;
  const firstOfNext = (y: number, m: number) => (m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`);
  const first = rows.map((row) => isoDate(row.effective_from)).sort()[0]!;
  const reached = paid.filter((p) => idx(p.year, p.month) >= idx(Number(first.slice(0, 4)), Number(first.slice(5, 7))));
  const latest = reached.length > 0 ? reached.reduce((a, b) => (idx(b.year, b.month) > idx(a.year, a.month) ? b : a)) : null;
  const afterPaid = latest ? firstOfNext(latest.year, latest.month) : null;
  const lastEnd = rows.map((row) => isoDate(row.effective_to)).sort().reverse()[0]!;
  const dayAfterEnd = lastEnd === endOfMonth(lastEnd)
    ? firstOfNext(Number(lastEnd.slice(0, 4)), Number(lastEnd.slice(5, 7)))
    : `${lastEnd.slice(0, 8)}${String(Number(lastEnd.slice(8, 10)) + 1).padStart(2, '0')}`;
  return afterPaid !== null && afterPaid > lastEnd ? afterPaid : dayAfterEnd;
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
  /** The once-offs the apply would refuse across EVERY component of the package (foreignOnceOffsOf): the date it names must clear all of them. */
  foreignAll?: DbRow[];
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

/**
 * The live once-offs this package did not write, on any of its components, that an apply from `effectiveFrom` would
 * overlap: what the date a refusal names has to clear, whichever component refuses first.
 */
export async function foreignOnceOffsOf(
  tx: TxSql, apply: { companyId: string; packageId: string; employeeId: string; effectiveFrom: string }, packageLines: DbRow[],
): Promise<DbRow[]> {
  const { companyId, packageId, employeeId, effectiveFrom } = apply;
  const foreign: DbRow[] = [];
  for (const componentId of packageLines.map((line) => String(line.component_id))) {
    const componentRows = (await tx`
      SELECT c.id, c.amount, c.effective_from, c.effective_to, c.is_recurring, c.superseded_at, c.supersede_inferred, e.end_date AS employee_end
        FROM payroll_employee_components c
        JOIN payroll_employees e ON e.id = c.employee_id AND e.company_id = ${companyId}::uuid
       WHERE c.employee_id = ${employeeId}::uuid AND c.component_id = ${componentId}::uuid
    `) as DbRow[];
    const rows = componentRows.filter((row) => row.is_recurring === false && row.superseded_at == null);
    const siblings: Sibling[] = componentRows.map((row) => ({ ...windowOf(row), id: String(row.id) }));
    // Ending (cancelling) a row must not revive a pre-953 once-off it replaced under the old neighbour rule: End refuses that.
    const endOk = (row: DbRow) => legacyFlips(siblings, siblings.map((x) => (x.id === String(row.id) ? { ...x, to: dayBefore(isoDate(row.effective_from)) } : x))).length === 0;
    const live = rows.filter((row) => (row.effective_to == null || isoDate(row.effective_to) >= effectiveFrom)
      && (row.effective_to == null || isoDate(row.effective_to) >= isoDate(row.effective_from)));
    const maybe = new Set<string>();
    const own = await ownOnceOffs(tx, companyId, packageId, componentId, live, maybe);
    foreign.push(...live.filter((row) => !own.has(String(row.id))).map((row) => (maybe.has(String(row.id)) ? { ...row, maybe_own: true, end_ok: endOk(row) } : row)));
  }
  return foreign;
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
    SELECT c.id, c.amount, c.effective_from, c.effective_to, c.is_recurring, c.superseded_at, c.supersede_inferred, e.end_date AS employee_end,
           c.employer_fund_as_cash, c.percent_of_rfi
      FROM payroll_employee_components c
      JOIN payroll_employees e ON e.id = c.employee_id AND e.company_id = ${companyId}::uuid
     WHERE c.employee_id = ${employeeId}::uuid
       AND c.component_id = ${componentId}::uuid
     ORDER BY c.id FOR UPDATE OF c
  `) as DbRow[];
  const overlapped = all.filter((row) => row.effective_to == null || isoDate(row.effective_to) >= effectiveFrom);
  // RF (migration 975): a package writes a plain amount, so replacing a pre-RF row kept as cash would silently make it the
  // employer's non-cash deemed contribution, and replacing a percent_of_rfi row would freeze it at a fixed amount. Refused
  // before any write; the employee's own profile does both changes deliberately.
  const rfRow = overlapped.find((row) => row.employer_fund_as_cash === true || row.percent_of_rfi != null);
  if (rfRow) {
    throw new EmployeeComponentRefused(rfRow.percent_of_rfi != null
      ? `This package would replace a retirement fund contribution set as ${formatPercent(Number(rfRow.percent_of_rfi))} of retirement-funding income (from ${isoDate(rfRow.effective_from)}) with a fixed amount. `
        + 'Remove that component from the package, or end the percentage on the employee profile first.'
      : `This package would replace an employer retirement fund contribution kept as cash from before RF (from ${isoDate(rfRow.effective_from)}), changing how it is taxed. `
        + 'End that assignment on the employee profile and assign the component again (as a % of retirement-funding income if the fund sets it so), then apply the package.');
  }
  // A recurring row is the package's to replace. A once-off is only if the package wrote it (a re-apply); one entered
  // by hand (a back-pay) is not: the apply is refused, with nothing written, rather than cancel it silently.
  // Only live, un-superseded once-offs are judged: a voided one (cancelled, End refuses it) and one an earlier apply
  // already replaced are paid by nobody, so they cannot be cancelled again.
  const liveOnceOffs = overlapped.filter((row) => row.is_recurring === false && row.superseded_at == null
    && (row.effective_to == null || isoDate(row.effective_to) >= isoDate(row.effective_from)));
  const maybe = new Set<string>();
  const own = await ownOnceOffs(tx, companyId, packageId, componentId, liveOnceOffs, maybe);
  const foreign = liveOnceOffs.filter((row) => !own.has(String(row.id))).map((row) => (maybe.has(String(row.id)) ? { ...row, maybe_own: true } : row));
  const foreignIds = new Set(foreign.map((row) => String(row.id)));
  const toCut = overlapped;
  // Never cut what a paid run read: that run would no longer agree with the rows (security review, 2026-11-02). Checked
  // first: a month already paid is the stronger reason, and its remedy leads.
  for (const row of toCut) {
    const changed = paidPeriodChanged(paid, windowOf(row), { ...windowOf(row), to: cutTo });
    if (changed) {
      if (foreignIds.has(String(row.id))) {
        const companyPaid = await paidPeriodsOf(tx, companyId, null);
        const applyFrom = applyFromAfter(input.foreignAll ?? foreign, companyPaid);
        if (foreign.find((f) => String(f.id) === String(row.id))?.maybe_own === true) {
          // End refuses a once-off a paid run read, and a new one cannot be dated in a paid month: only the apply-from route.
          throw new EmployeeComponentRefused(
            `${periodLabel(changed)} is already paid ${paidNote(changed)}, and applying this package from ${effectiveFrom} would cancel a once-off (from ${isoDate(row.effective_from)}) that run paid. `
            + `${unrecordedOriginAdvice(input.foreignAll ?? foreign, effectiveFrom, applyFrom, true, true)} To keep this date instead, ${paidRemedyInline(changed)} first.`);
        }
        throw new EmployeeComponentRefused(
          `${periodLabel(changed)} is already paid ${paidNote(changed)}, and applying this package from ${effectiveFrom} would cancel a once-off this package did not write `
          + `(from ${isoDate(row.effective_from)}) that run paid. ${applyFrom ? `Apply the package from ${applyFrom}` : 'Apply the package from a later date'}; or, to keep this date, ${paidRemedyInline(changed)} and then end or move that once-off.`);
      }
      throw new EmployeeComponentRefused(
        `${periodLabel(changed)} is already paid ${paidNote(changed)}, and applying this package from ${effectiveFrom} would cut an `
        + `assignment that run paid (from ${isoDate(row.effective_from)}). ${paidRemedy(changed)}, or apply the package from a later date.`);
    }
  }
  if (foreign.length > 0) {
    const applyFrom = applyFromAfter(input.foreignAll ?? foreign, await paidPeriodsOf(tx, companyId, null));
    const named = foreign.map((row) => `${isoDate(row.effective_from)} to ${row.effective_to ? isoDate(row.effective_to) : 'open-ended'}, amount ${Number(row.amount).toFixed(2)}`);
    if ((input.foreignAll ?? foreign).some(isAmbiguous)) {
      const companyPaid = await paidPeriodsOf(tx, companyId, null);
      const fromPaid = companyPaid.some((p) => p.year === Number(effectiveFrom.slice(0, 4)) && p.month === Number(effectiveFrom.slice(5, 7)));
      throw new EmployeeComponentRefused(
        `Applying this package from ${effectiveFrom} would cancel ${foreign.length === 1 ? 'a once-off' : 'once-offs'} on this component: ${named.join(', ')}. `
        + unrecordedOriginAdvice(input.foreignAll ?? foreign, effectiveFrom, applyFrom, fromPaid, false));
    }
    throw new EmployeeComponentRefused(
      `Applying this package from ${effectiveFrom} would cancel ${foreign.length === 1 ? 'a once-off' : 'once-offs'} this package did not write `
      + `(entered by hand, posted by a batch, or written by another package) on this component: ${named.join(', ')}. End or move ${foreign.length === 1 ? 'it' : 'them'} first, or apply the package from ${applyFrom ?? 'a later date'}.`);
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
