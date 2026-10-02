/**
 * WHY A PACK IS A DRAFT — and why it has to EARN "FINAL".
 *
 * Brightsphere's cover printed "This pack is FINAL." and ISAFlow Demo's, from
 * the same code on the same day, printed "This pack is a DRAFT — figures are
 * not final." Both were rendered from the same command. The difference was
 * real — Brightsphere's September 2026 fiscal period is closed in the ledger
 * and Demo's is open — and the sentence it produced was still wrong, because
 * the pack was measuring one fact and asserting a different one.
 *
 * "The fiscal period is closed" means THE FIGURES WILL NOT MOVE. It does not
 * mean anyone has read the pack. Brightsphere has no approved commentary, its
 * colour language inverts on its own data, and three of its trend titles read
 * "rose from – to –" — and it told a board it was final. Draft status is the
 * one label on the pack whose failure a director cannot detect by reading:
 * every other defect is visible on the page, and this one is invisible and
 * load-bearing.
 *
 * So it is derived from POSITIVE evidence in both directions, and there is no
 * single `draft` boolean carrying two facts. A pack is final only where the
 * ledger is closed AND a human approved commentary on the period. Absence of
 * either produces DRAFT, which is the same fail-closed shape
 * `PackKpiDeltaAbsence` gave a tile with no movement and `getLedgerPostedThrough`
 * gives a window with nothing posted: an absent fact is stated, never
 * defaulted into its opposite.
 *
 * AND THE PAGE SAYS WHICH. "DRAFT" alone tells a director to distrust the
 * pack without saying what to wait for; a period that closes next week and a
 * commentary nobody has written are different waits.
 */

/** Every reason a pack is not final. Empty means it is. */
export type PackDraftReason = 'openPeriod' | 'noPeriod' | 'unapprovedCommentary';

/** `getPeriodStatusForDate`'s answer, as this module needs it. Restated
 *  rather than imported so the composer stays free of the fetcher. */
export type PackPeriodStatus = 'open' | 'closed' | 'no_period';

/**
 * @param periodStatus The fiscal period the reporting date falls in.
 * @param commentaryApproved Whether a human has approved commentary on this
 *   period — `approvedCommentary(...) !== null`. NOT "is there commentary":
 *   a draft is machine-written text nobody signed.
 */
export function draftReasons(
  periodStatus: PackPeriodStatus,
  commentaryApproved: boolean,
): PackDraftReason[] {
  const reasons: PackDraftReason[] = [];
  if (periodStatus === 'open') reasons.push('openPeriod');
  if (periodStatus === 'no_period') reasons.push('noPeriod');
  if (!commentaryApproved) reasons.push('unapprovedCommentary');
  return reasons;
}

const REASON_CLAUSE: Record<PackDraftReason, string> = {
  openPeriod: 'the fiscal period it ends in is still open, so these figures can still move',
  noPeriod: 'no fiscal period covers the reporting date, so nothing has fixed these figures',
  unapprovedCommentary: 'no commentary on this period has been approved, so nobody has signed off what it says',
};

/** "a, b and c" over the clauses, in the order the reasons were found. */
function inWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The sentence the cover and the basis page's caveat both print.
 *
 * ONE definition, because they are the same claim: a pack that says DRAFT on
 * its cover and lists no draft caveat, or the reverse, is a pack whose two
 * statements about its own status disagree.
 */
export function draftStatusSentence(reasons: PackDraftReason[]): string {
  if (reasons.length === 0) {
    return 'This pack is FINAL: the fiscal period it ends in is closed, and its commentary has been approved.';
  }
  return `This pack is a DRAFT — ${inWords(reasons.map((r) => REASON_CLAUSE[r]))}.`;
}
