/**
 * Pure: what must agree between a run's plan and the journal in force, for the
 * approval gate's `recalculated_after_posting` check (payrollApprovalGate).
 * Split out of the gate to keep it under the 300-line cap.
 *
 * `figures` keys every line, in cents: each credit by GL account (PAYE, UIF,
 * SDL, deductions, net pay — each a header total), and the labour debit.
 *
 * Labour is ONE total for a run that has not been recalculated since the
 * journal posted. Its split across cost-centre accounts then follows today's
 * cost centres, mappings and allocations (and, before the split's reads were
 * ordered, the heap's order for its rounding cent) — none of which is the run
 * changing, and a journal is not wrong for carrying the split of its day
 * (breaker B, C).
 *
 * Labour is PER (ACCOUNT, CC1) once the run HAS been recalculated since
 * (`perAccount`). A recalculation can move pay between employees in different
 * cost centres and leave every header total as it was; the split is then the
 * only place the change shows (breaker C4), and since labour lines carry the
 * employee's centre (2026-11-02) a move between two centres mapped to one
 * account is the same kind of change. `comparableLines` decides how each side
 * names its CC1 first.
 */

export type FigureLine = { glAccountId: string | null; debit: number; credit: number; cc1Id: string | null };

/** The plan's labour per (account, SOURCE centre) — before untaggable centres were merged into untagged. */
export interface LabourSourceBucket {
  glAccountId: string;
  /** The employee's centre (allocation or own), or null when they have none. */
  centreId: string | null;
  /** Whether the plan tags this centre (active, cc_type 'cc1'). */
  taggable: boolean;
  debit: number;
}

const cents = (n: number): number => Math.round(n * 100);

/** The description of the plan's net-pay credit (payrollJournalBank#bankNetPayLine): how the comparison finds it. */
export const NET_PAY_DESCRIPTION = 'Net pay — bank disbursement';
/** Stands for "whichever account holds the bank role" on both sides of the comparison. */
const BANK_ROLE = 'bank-role';

/** A posted journal line as the comparison reads it: its `gl_journal_lines.description` says which line is net pay. */
export type PostedFigureLine = FigureLine & { description: string | null };

/**
 * Net pay's bank credit is ONE role, not an account (re-approval after the
 * bank role moved). The plan names today's holder; the journal in force names
 * whoever held the role when it posted, and the cash left from THAT account.
 * Keyed by account id, an unchanged run read as `recalculated_after_posting`
 * once the role moved (or had no holder), and the advised reverse-and-approve
 * would have credited a different bank than the cash left from. So both sides
 * key the net-pay credit as the role, and only its AMOUNT is compared.
 *
 * Exactly ONE line is folded on each side, found by its description
 * (NET_PAY_DESCRIPTION, which the poster has written to `gl_journal_lines`
 * since payroll journals existed, 0fffb05a5). Every other posted line stays
 * keyed by its account, so a credit the recalculated plan no longer carries
 * (PAYE, UIF, SDL or 2175 gone to zero — the builder drops zero lines) is a
 * difference. Folding by "any credit on an account the plan does not use"
 * instead moved that credit into the bank bucket; both journals balance, so the
 * bucket's amount matched and a changed run re-locked onto its stale journal.
 *
 * A posted journal with no single net-pay line is not folded at all: both sides
 * stay keyed by account, which is the comparison from before the bank role
 * could move.
 */
export function foldNetPayBank<P extends FigureLine & { description: string }>(
  plan: P[],
  posted: PostedFigureLine[],
): { plan: FigureLine[]; posted: FigureLine[] } {
  const netPay = posted.filter((l) => l.description === NET_PAY_DESCRIPTION && cents(l.debit) === 0 && cents(l.credit) > 0);
  if (netPay.length !== 1) return { plan, posted };
  return {
    plan: plan.map((l) => (l.description === NET_PAY_DESCRIPTION ? { ...l, glAccountId: BANK_ROLE } : l)),
    posted: posted.map((l) => (l === netPay[0] ? { ...l, glAccountId: BANK_ROLE } : l)),
  };
}

export function figures(lines: FigureLine[], perAccount: boolean): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    const k = cents(l.debit) !== 0 && !perAccount ? 'labour' : JSON.stringify([l.glAccountId ?? 'missing', l.cc1Id]);
    m.set(k, (m.get(k) ?? 0) + cents(l.debit) - cents(l.credit));
  }
  for (const [k, v] of m) if (v === 0) m.delete(k);
  return m;
}

export function sameFigures(lines: { plan: FigureLine[]; posted: FigureLine[] }, perAccount: boolean): boolean {
  const a = figures(lines.plan, perAccount);
  const b = figures(lines.posted, perAccount);
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}

/**
 * The two sides of the per-(account, CC1) comparison (PR #1065 review rounds
 * 1–2). `posted` is the journal AS POSTED: a CC1 the tag tool changed since is
 * read back from its first `dimension_tag_batch_lines.old_cc1_id`
 * (payrollApprovalGate#readPostedJournal), because re-tagging the ledger is
 * not the run changing.
 *
 *  - No labour line carried a CC1 as posted: CC1 is stripped only while the
 *    current plan is also wholly untagged. Once the plan tags labour, the old
 *    journal cannot prove that labour belonged to the same centre, so the
 *    comparison fails closed and requires reversal and reposting.
 *  - Otherwise the plan's labour is taken per SOURCE centre (`bySource`), so
 *    centres the plan cannot tag today stay apart: a centre the journal
 *    carries on that account keeps its id (deactivated since posting, it still
 *    equals its posted line; a move between two such centres still differs);
 *    any other centre keeps its id when the plan tags it, else reads as
 *    untagged (it was untaggable at posting too, so it sits in the journal's
 *    untagged line). A centre taggable now that the journal does not carry is a
 *    difference — fail closed, even for one reactivated since posting.
 *
 * `bySource` is absent only when the plan had no labour account to split onto;
 * the plan's own lines are used then.
 */
export function comparableLines(
  planLines: FigureLine[],
  bySource: LabourSourceBucket[] | undefined,
  posted: FigureLine[],
): { plan: FigureLine[]; posted: FigureLine[] } {
  const key = (account: string | null, centre: string) => JSON.stringify([account, centre]);
  const carried = new Set(posted.filter((l) => cents(l.debit) !== 0 && l.cc1Id).map((l) => key(l.glAccountId, l.cc1Id!)));
  if (carried.size === 0) {
    if (predatesTagging(planLines, posted)) return { plan: planLines, posted };
    const untag = (l: FigureLine): FigureLine => ({ ...l, cc1Id: null });
    return { plan: planLines.map(untag), posted: posted.map(untag) };
  }
  if (!bySource) return { plan: planLines, posted };
  const labour = bySource.map((b): FigureLine => ({
    glAccountId: b.glAccountId,
    debit: b.debit,
    credit: 0,
    cc1Id: b.centreId !== null && (carried.has(key(b.glAccountId, b.centreId)) || b.taggable) ? b.centreId : null,
  }));
  return { plan: [...planLines.filter((l) => cents(l.debit) === 0), ...labour], posted };
}

/**
 * True when the posted journal carries no CC1 on any labour line while the plan
 * tags labour: a journal from before cost-centre tagging (or one whose centres
 * were all untaggable then). `comparableLines` fails such a comparison closed
 * (d416d6de6), and the gate's refusal names this cause.
 */
export function predatesTagging(planLines: FigureLine[], posted: FigureLine[]): boolean {
  return !posted.some((l) => cents(l.debit) !== 0 && l.cc1Id) && planLines.some((l) => cents(l.debit) !== 0 && l.cc1Id !== null);
}
