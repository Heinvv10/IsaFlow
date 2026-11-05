/**
 * A payroll journal post / approval that Postgres chose as the victim of a deadlock (40P01).
 *
 * One JSON-RPC batch to the MCP endpoint runs in ONE transaction, so a call that created a journal still holds the
 * company-wide journal-numbering advisory lock when the next call locks another run's header; a second batch doing
 * the same in the opposite order inverts "header, then numbering" (payrollRunLock's LOCK ORDER). The victim is
 * answered as this retryable refusal instead of GENERIC_FAILURE. It carries a registered refusal code, so the
 * registry keeps its message on a throw (the savepoint has rolled the call back: this call wrote nothing).
 */

/** Postgres `deadlock_detected`. */
export function isDeadlockDetected(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '40P01';
}

export class PayrollJournalDeadlockError extends Error {
  readonly code = 'PAYROLL_RUN_LOCK_TIMEOUT';
  constructor(runId: string) {
    super(
      `Payroll run ${runId} was not posted: another request holding a lock this call needs was waiting on a lock `
      + 'this transaction holds (several runs posted in one batch, in opposite orders). This call wrote nothing; '
      + 'retry it, and post one run per request.',
    );
    this.name = 'PayrollJournalDeadlockError';
  }
}
