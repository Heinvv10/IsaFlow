/**
 * The errors bank status mutations raise. Split out of bankTxStatusMutations (300-line rule), which re-exports them.
 */

/** The page's Undo reads this sentence: the client's own re-read says the same thing for a change it can see. */
export const LINE_CHANGED_MESSAGE = 'This line has changed since you allocated it.';

/**
 * A toast outlives the state it was offered for, and a client's read leaves a gap before its write. So an undo says
 * what it expects, and the server refuses under the row lock, before any write, when the line has moved on. 409.
 */
export class BankLineChangedError extends Error {
  constructor() {
    super(LINE_CHANGED_MESSAGE);
    this.name = 'BankLineChangedError';
  }
}

/**
 * Raised when a status mutation is asked to overwrite a row that carries a
 * posted journal. The bank API routes return a caught service error's message
 * as a 400, so this wording is what the caller reads.
 */
export class BankTransactionAllocatedError extends Error {
  readonly code = 'BANK_TX_ALLOCATED';
  constructor(bankTxId: string, status: string, verb: string) {
    super(
      `Bank transaction ${bankTxId} is ${status} with a posted journal — `
      + `reverse the allocation before you ${verb} it.`,
    );
    this.name = 'BankTransactionAllocatedError';
  }
}

/**
 * Raised when a match names a target this company cannot use, or a journal line
 * another bank transaction already holds.
 *
 * Typed rather than a bare `Error` because `autoMatchTransactions` rethrows
 * everything it does not recognise, and `withAuth` COMMITs the 4xx the route
 * then returns — so an escaping throw aborts the run with the matches it had
 * already applied persisted. `LINE_CLAIMED` is exactly the race that loop was
 * written to tolerate (the candidate query excludes claimed lines, so it can
 * only fire when a peer binds the line in between), so the code is what lets
 * the loop skip that one case and keep rethrowing the rest.
 */
export type BankMatchTargetCode = 'LINE_NOT_FOUND' | 'LINE_CLAIMED' | 'LINE_REVERSED' | 'RECONCILIATION_NOT_FOUND';

export class BankMatchTargetError extends Error {
  constructor(readonly code: BankMatchTargetCode, message: string) {
    super(message);
    this.name = 'BankMatchTargetError';
  }
}
