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

/** The follow-up that would allow a person to eliminate a mirrored row by hand (design only: nothing implements it yet). */
export const MIRRORED_ROW_MANUAL_ELIMINATION_DOC = 'docs/plans/2026-11-22-intercompany-manual-elimination-of-mirrored-rows.md';

/**
 * A manual elimination may not carry an intercompany row that a mirrored document records (400). Manual elimination of a mirrored row is NOT
 * SUPPORTED YET: its interactions with the derived elimination and with manual (P1) rows are not designed (MIRRORED_ROW_MANUAL_ELIMINATION_DOC).
 * Fix the receiver's side instead, so that mirroring eliminates the row.
 */
export class EliminationMirroredRowUnsupportedError extends Error {
  constructor(readonly sourceIntercompanyId: string | null = null) {
    super('Manual elimination of a mirrored intercompany row is not supported yet. Correct or re-accept the receiving company\'s document (or cancel the sale) '
      + `so that mirroring eliminates it. The planned follow-up is described in ${MIRRORED_ROW_MANUAL_ELIMINATION_DOC}.`);
    this.name = 'EliminationMirroredRowUnsupportedError';
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
