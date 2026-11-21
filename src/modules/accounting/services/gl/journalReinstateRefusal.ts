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

/** The CONSTRAINT name gl_je_reversal_link raises a full (63-journal) or branched chain with (round 4 L2). */
export const REVERSAL_CHAIN_FULL = 'gl_je_reversal_chain_full';

export class JournalReversalChainFullError extends Error {
  readonly code = 'JOURNAL_REVERSAL_CHAIN_FULL';
  constructor(entryNumber: string) {
    super(`Journal entry ${entryNumber} cannot be reversed: its reversal chain is full (a chain holds fewer than 64 journals `
      + 'in one line) or branched. Post a new journal for the correction instead.');
    this.name = 'JournalReversalChainFullError';
  }
}

/** True when `err` is the database's refusal of a link onto a full or branched reversal chain. */
export function isReversalChainFullRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { constraint?: unknown }).constraint === REVERSAL_CHAIN_FULL;
}

/** The CONSTRAINT name of the exact-negation refusal (a contra whose lines do not mirror the original's). */
export const REVERSAL_NOT_NEGATION = 'gl_je_reversal_not_negation';
/** The CONSTRAINT name of the retryable "chain changed while it was being linked" refusal (SQLSTATE 40001). */
export const REVERSAL_CHAIN_CHANGED = 'gl_je_reversal_chain_changed';

/** Any other refusal of the reversal link by migration 1018, in the user's words: no table name, no SQLSTATE. */
export class JournalReversalRefusedError extends Error {
  readonly code = 'JOURNAL_REVERSAL_REFUSED';
  constructor(entryNumber: string, reason: string) {
    super(`Journal entry ${entryNumber} cannot be reversed: ${reason}`);
    this.name = 'JournalReversalRefusedError';
  }
}

/**
 * Round 10 L4: every refusal the reversal link can meet in migration 1018, as the error the caller should see. Null
 * for anything else (the caller rethrows it). `retry` builds the 503 (Retry-After) error for the two refusals that a
 * retry can pass: the chain changed while it was being linked, and the read-committed rule (40001).
 */
export function ledgerLinkRefusal(err: unknown, entryNumber: string, retry: () => Error): Error | null {
  if (typeof err !== 'object' || err === null) return null;
  const { constraint, code, message } = err as { constraint?: unknown; code?: unknown; message?: unknown };
  if (constraint === REINSTATES_CANCELLED_DOCUMENT) return new JournalReinstatesCancelledDocumentError(entryNumber);
  if (constraint === REVERSAL_CHAIN_FULL) return new JournalReversalChainFullError(entryNumber);
  if (constraint === REVERSAL_CHAIN_CHANGED || code === '40001') return retry();
  if (constraint === REVERSAL_NOT_NEGATION) {
    return new JournalReversalRefusedError(entryNumber, 'its reversal would not mirror it line for line (an account '
      + 'or VAT type differs). Correct it with a new journal instead.');
  }
  if (code === '23514' && typeof message === 'string' && message.startsWith('gl_journal_entries: ')) {
    return new JournalReversalRefusedError(entryNumber, `${message.slice('gl_journal_entries: '.length)}.`);
  }
  return null;
}
