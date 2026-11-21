/**
 * Expected refusals from the elimination journal (consolidatedReportingService), typed so the
 * consolidated-reports route answers 400 / 409 with the message instead of a 500 from a plain
 * Error. Anything else the service throws is still a 500.
 */

/** Lines do not balance — a caller error (400). */
export class EliminationUnbalancedError extends Error {
  constructor(readonly totalDebit: number, readonly totalCredit: number) {
    super(`Elimination lines do not balance: debits ${totalDebit.toFixed(2)}, credits ${totalCredit.toFixed(2)}.`);
    this.name = 'EliminationUnbalancedError';
  }
}

/**
 * Post / reverse found no adjustment of this group in the status it needs (409): it is missing,
 * belongs to another group, or was already posted / reversed. One UPDATE decides, so the three
 * cases are not told apart.
 */
export class EliminationStateError extends Error {
  constructor(readonly adjustmentId: string, readonly requiredStatus: 'draft' | 'posted') {
    super(`This elimination is not a ${requiredStatus} adjustment of this group `
      + `(missing, another group's, or already ${requiredStatus === 'draft' ? 'posted' : 'reversed'}).`);
    this.name = 'EliminationStateError';
  }
}

/**
 * An elimination for this intercompany row already stands (draft or posted): the partial unique index on
 * consolidation_adjustments(source_intercompany_id) refused a second. The generator treats it as a skip.
 */
export class EliminationAlreadyStandsError extends Error {
  constructor(readonly sourceIntercompanyId: string) {
    super(`An elimination for intercompany row ${sourceIntercompanyId} already stands.`);
    this.name = 'EliminationAlreadyStandsError';
  }
}

/**
 * Posting a draft whose row may be the same sale as a live mirrored document (409). The message says what is true: when the mirror is
 * eliminated automatically, posting this would eliminate the sale twice; when it is not (booked by the receiver in another financial year,
 * not approved, or reversed), this may be the sale's only elimination. Either way the person confirms to post it.
 */
export class EliminationPossibleDuplicateError extends Error {
  constructor(readonly adjustmentId: string, readonly mirroredRef: string, readonly mirrorStands: boolean, readonly pairCutover: string | null = null) {
    super(possibleDuplicateMessage(mirroredRef, mirrorStands, pairCutover));
    this.name = 'EliminationPossibleDuplicateError';
  }
}

/**
 * The one wording of a possible duplicate (the 409 and the page's confirm both use it). `pairCutover`: the row is on or after its pair's
 * cutover, so the generator drafted it because that mirror does not account for it (it accounts for a closer row, or none stands).
 */
export function possibleDuplicateMessage(mirroredRef: string, mirrorStands: boolean, pairCutover: string | null = null): string {
  if (!mirrorStands) {
    return `Possibly the same sale as mirrored document ${mirroredRef}, which is NOT eliminated automatically at the moment (booked by the receiver in another financial year, not approved yet, or reversed): this may be the sale's only elimination. If the receiver books it in the same financial year later, the two would eliminate it twice. Confirm to post it.`;
  }
  if (pairCutover) return `${matchedElsewhereText(mirroredRef, pairCutover)} If it is the same sale, posting this would eliminate it twice. Confirm to post it.`;
  return `Possibly the same sale as mirrored document ${mirroredRef}, which is eliminated automatically: posting this would eliminate the sale twice. Confirm to post it anyway.`;
}

/**
 * The one wording (the list's badge, the 409 and the confirm) for a row on or after its pair's cutover that was drafted although a mirror it
 * matches is eliminated automatically: that mirror was matched to a different row.
 */
export function matchedElsewhereText(mirroredRef: string, pairCutover: string): string {
  return `Possibly the same sale as mirrored document ${mirroredRef}, which is eliminated automatically, but that mirror was matched to a different row (the pair mirrors from ${pairCutover}).`;
}
