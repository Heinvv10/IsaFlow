/**
 * A bank request refused before anything was written, carrying the status its route answers (audit WP2 row 9).
 *
 * For the refusals that used to be bare `Error`s — a session, a run or a line that is not there, a split that does not
 * add up, an adjustment on the wrong bank — which the bank routes could tell from a crash only by answering EVERY throw
 * 400. A 4xx COMMITs the request (withAuth), so that catch-all committed whatever a crash had written. With these
 * typed, the routes answer the typed refusals and rethrow the rest (500, rolled back).
 *
 * Raise it only where nothing has been written yet (or inside a savepoint the throw rolls back).
 */
export type BankRequestRefusalStatus = 400 | 404 | 409;

export class BankRequestRefusal extends Error {
  readonly code = 'BANK_REQUEST_REFUSED';
  constructor(message: string, readonly status: BankRequestRefusalStatus = 400) {
    super(message);
    this.name = 'BankRequestRefusal';
  }
}

/** Structural, as `isBankAllocationRefusal`: one class, whichever copy of the module raised it. */
export function isBankRequestRefusal(err: unknown): err is BankRequestRefusal {
  return err instanceof Error && (err as { code?: unknown }).code === 'BANK_REQUEST_REFUSED';
}
