/**
 * Migration 1018 (round 3, M1): the database refuses a reversal link that would put a cancelled document's journal back
 * in force. Approve -> cancel leaves O <- R; reversing R again would post R2 and bring O (and the cancelled invoice,
 * bill or credit note) back into the GL while the sub-ledger still excludes the document. The trigger
 * (`gl_je_reversal_link`) raises with this constraint name; the reversal service turns it into the refusal below. The
 * statement error has already aborted the transaction (or its savepoint), so nothing the reversal wrote survives.
 */

/** The CONSTRAINT name gl_je_reversal_link raises the refusal with. */
export const REINSTATES_CANCELLED_DOCUMENT = 'gl_je_reinstates_cancelled_document';

export class JournalReinstatesCancelledDocumentError extends Error {
  readonly code = 'JOURNAL_REINSTATES_CANCELLED_DOCUMENT';
  constructor(entryNumber: string) {
    super(`Journal entry ${entryNumber} cannot be reversed: that would put the journal of a cancelled document back in `
      + 'the ledger. A cancelled document stays out of the books; enter a new document or journal if the amount belongs '
      + 'in them again.');
    this.name = 'JournalReinstatesCancelledDocumentError';
  }
}

/** True when `err` is the database's refusal of a link that re-instates a cancelled document's journal. */
export function isReinstateCancelledDocumentRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { constraint?: unknown }).constraint === REINSTATES_CANCELLED_DOCUMENT;
}
