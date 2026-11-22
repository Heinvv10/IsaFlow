/**
 * An error that stopped a run AFTER its live phase started. It carries what was committed before it (the batches that came back ok), so the
 * caller can print that even though the final reconciliation could not be read. An error before the live phase (a bad file, not a member,
 * the guard, the account check, the dry run) is thrown as it is: nothing was written, and nothing says otherwise.
 */
import type { BatchReport } from './sageMigrationTypes';

export class MigrationStopped extends Error {
  constructor(readonly reason: unknown, readonly liveStarted: boolean, readonly committed: BatchReport[]) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = 'MigrationStopped';
  }
}
