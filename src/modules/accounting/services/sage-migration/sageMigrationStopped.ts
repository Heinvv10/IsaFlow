/**
 * An error that stopped a run AFTER its live phase started. It carries what was committed before it (the batches that came back ok, and
 * the one whose COMMIT is unconfirmed) and the batches that failed before it (nothing of them written), so the caller can print that even though the final reconciliation could not be
 * read. An error before the live phase (a bad file, not a member, the guard, the account check, the dry run) is thrown as it is: nothing
 * was written, and nothing says otherwise.
 */
import type { BatchReport } from './sageMigrationTypes';
import { told } from './sageTold';

export interface StoppedBatches {
  /** Live batches that failed before the stop and wrote nothing (refused by the tool, or their request rolled back). */
  failed: BatchReport[];
  /** The books could not be read after the stop (why): the committed list is as the run recorded it, not re-checked against them. */
  booksNotRechecked?: string;
}

export class MigrationStopped extends Error {
  constructor(readonly reason: unknown, readonly liveStarted: boolean, readonly committed: BatchReport[], readonly batches: StoppedBatches = { failed: [] }) {
    super(told(reason));
    this.name = 'MigrationStopped';
  }
}
