/**
 * What the CLI knows of a run while it runs (round 18 decision): the runner reports its progress (MigrationOptions.onProgress) and this
 * keeps it, so a run ended AT ONCE (a second signal, an uncaught error) still writes a stop report saying what is known: whether the live
 * phase started, the live batches recorded (committed / nothing written / failed), and a batch in flight, listed as commit unconfirmed.
 * None of it is re-checked against the books there (the usual stop path does that; this one cannot wait for the database).
 *
 * `ended` (R29-1): the run has ended, decided at once by the CLI (terminate) or by an exit path. From then no batch is sent and no
 * request is started (the CLI's shouldStop and the runner's sessions read it); only the batch in flight at that moment can still settle,
 * and its outcome is handed to `onSettledAfterEnd`, never followed by another batch.
 */
import type { BatchReport, MigrationProgress } from '../../src/modules/accounting/services/sage-migration/sageMigrationTypes';
import { MigrationStopped } from '../../src/modules/accounting/services/sage-migration/sageMigrationStopped';

export class RunState {
  /** 'start' until the dry run begins; 'live' once the live phase started (from then batches may be committed). */
  phase: 'start' | 'dry' | 'live' = 'start';
  /** The run returned and its exit code is set (its own report written or tried): an end at once then changes nothing. */
  finished = false;
  readonly committed: BatchReport[] = [];
  readonly failed: BatchReport[] = [];
  inFlight: Pick<BatchReport, 'entity' | 'n' | 'size' | 'key'> | null = null;
  /** Why the run ended (set once, synchronously, before any wait); null while it runs. */
  ended: string | null = null;
  /** The batch in flight when the run ended (its outcome may still come). */
  inFlightAtEnd: Pick<BatchReport, 'entity' | 'n' | 'size' | 'key'> | null = null;
  /** Hears the outcome of the batch in flight when the run ended, once it settles. */
  onSettledAfterEnd: ((batch: BatchReport) => void) | null = null;

  /** Ends the run: nothing new starts after this. The first reason stands. */
  end(why: string): void {
    if (this.ended !== null) return;
    this.ended = why;
    this.inFlightAtEnd = this.liveStarted ? this.inFlight : null; // a dry batch writes nothing: there is nothing of it to wait for
  }

  readonly onProgress = (p: MigrationProgress): void => {
    if (p.kind === 'phase') this.phase = p.phase;
    else if (p.kind === 'sending') this.inFlight = p.batch;
    else if (p.phase === 'dry') return; // a dry batch wrote nothing: a stop has nothing to say of it
    else {
      this.inFlight = null;
      (p.batch.status === 'ok' || p.batch.commitUnconfirmed ? this.committed : this.failed).push(p.batch);
      if (this.ended !== null && this.inFlightAtEnd?.key === p.batch.key) { this.inFlightAtEnd = null; this.onSettledAfterEnd?.(p.batch); }
    }
  };

  get liveStarted(): boolean { return this.phase === 'live'; }

  /**
   * The error a stop at once reports: after the live phase started, a MigrationStopped with the batches recorded so far and the one in
   * flight as commit unconfirmed (exit 4); before it, the plain reason (nothing written, exit 2).
   */
  stoppedAtOnce(why: string): Error {
    const reason = new Error(`${why} (stopped at once: the batches below are as recorded, not re-checked against the books)`);
    if (!this.liveStarted) return new Error(why);
    const inFlight: BatchReport[] = this.inFlight ? [{
      ...this.inFlight, status: 'failed', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: null, commitUnconfirmed: true,
      error: 'in flight when the run was stopped at once: its COMMIT may or may not have landed',
    }] : [];
    return new MigrationStopped(reason, true, [...this.committed, ...inFlight], { failed: this.failed });
  }
}
