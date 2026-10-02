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
    super(`Adjustment ${adjustmentId} is not a ${requiredStatus} adjustment of this group `
      + `(missing, another group's, or already ${requiredStatus === 'draft' ? 'posted' : 'reversed'}).`);
    this.name = 'EliminationStateError';
  }
}
