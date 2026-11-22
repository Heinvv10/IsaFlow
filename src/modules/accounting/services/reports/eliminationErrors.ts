/**
 * Expected refusals from the elimination journal (consolidatedReportingService), typed so the
 * consolidated-reports route answers 400 / 409 with the message instead of a 500 from a plain
 * Error. Anything else the service throws is still a 500.
 */
import { possibleDuplicateMessage, type MirrorFacts } from './mirrorFacts';

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
      + `(missing, another group's, or already ${requiredStatus === 'draft' ? 'posted or discarded' : 'reversed'}).`);
    this.name = 'EliminationStateError';
  }
}

/**
 * An elimination for this intercompany row already stands (draft or posted): the partial unique index on
 * consolidation_adjustments(source_intercompany_id) refused a second. The generator treats it as a skip.
 */
export class EliminationAlreadyStandsError extends Error {
  constructor(readonly sourceIntercompanyId: string) {
    super(`An elimination for intercompany row ${sourceIntercompanyId} already stands: discard it (a draft) or reverse it (a posted one) before making another.`);
    this.name = 'EliminationAlreadyStandsError';
  }
}

/** The row a manual elimination names is not one a message records in this group, or is dated outside the elimination's period (400). */
export class EliminationSourceError extends Error {
  constructor(readonly sourceIntercompanyId: string, why: string) {
    super(`Intercompany row ${sourceIntercompanyId} cannot be eliminated by hand here: ${why}.`);
    this.name = 'EliminationSourceError';
  }
}

/**
 * A manual elimination of a mirrored row needs the row to be one the mirror leaves un-eliminated for the elimination's period (409): the mirror
 * eliminates it now (the receiver accepted and approved it), it waits in the receiver's inbox, or a person's elimination already counts for it.
 */
export class EliminationNotUnresolvedError extends Error {
  constructor(readonly sourceIntercompanyId: string, readonly period: string) {
    super(`Intercompany row ${sourceIntercompanyId} has nothing to eliminate by hand for ${period}: the mirror now eliminates it, it waits in the receiver's inbox, or another elimination already counts for it.`);
    this.name = 'EliminationNotUnresolvedError';
  }
}

/**
 * Posting a draft whose row may be the same sale as a live mirrored document (409). The message is the facts' one wording (mirrorFacts.ts):
 * which mirror(s), how much of the row is eliminated automatically for the period, whose link holds them. The person confirms to post it.
 */
export class EliminationPossibleDuplicateError extends Error {
  readonly mirroredRef: string;
  constructor(readonly adjustmentId: string, readonly facts: MirrorFacts, readonly pairCutover: string | null = null) {
    super(possibleDuplicateMessage(facts, pairCutover));
    this.name = 'EliminationPossibleDuplicateError';
    this.mirroredRef = facts.label;
  }
}
