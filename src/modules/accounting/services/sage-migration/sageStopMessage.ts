/**
 * What the CLI says when the run stops on an error. Only an error after the live phase actually STARTED (MigrationStopped) says the run may
 * have committed, and lists, batch by batch, what it did to the books:
 *   - committed (with the owned items / categories it put back to Sage's values: those IsaFlow edits are overwritten, and a dry run run
 *     after the stop no longer shows them), answered ok but wrote nothing, or replayed with its rows absent;
 *   - commit unconfirmed (with what it may have updated, from the dry run's answer for that batch);
 *   - failed, nothing written, with the reason.
 * Any other error wrote nothing and says only why. PURE.
 */
import { CONSOLE_ERROR_CHARS } from './sageReportSummary';
import { updatesOf } from './sageDifferences';
import { MigrationStopped } from './sageMigrationStopped';
import type { BatchReport } from './sageMigrationTypes';

const cut = (text: string | null): string =>
  text === null ? 'no reason given' : text.length <= CONSOLE_ERROR_CHARS ? text : `${text.slice(0, CONSOLE_ERROR_CHARS)} ... (${text.length} characters)`;
const updates = (b: BatchReport | undefined, what: string): string =>
  (b ? updatesOf(b) : []).map((u) => `\n  ${what}: ${u.kind} ${u.name} (${u.changed.join(', ') || 'no detail given'})`).join('');

export function stopMessage(err: unknown): string {
  const why = `sage migration stopped: ${err instanceof Error ? err.message : String(err)}`;
  if (!(err instanceof MigrationStopped) || !err.liveStarted) return why;
  const line = (b: BatchReport, what: string) => `\n${what}: ${b.entity} batch ${b.n} (${b.key})`;
  const dryOf = (b: BatchReport) => err.batches.dryRun.find((d) => d.entity === b.entity && d.n === b.n);
  const committed = err.committed.map((b) => {
    if (b.status === 'failed' && b.rowsAbsent > 0) return line(b, 'replayed: rows absent, nothing written (use --run-tag for a fresh import)');
    if (b.status === 'ok') {
      return b.allRowsAlreadyPresent ? line(b, 'answered ok, nothing new written (its rows were already there)')
        : line(b, 'committed') + updates(b, "was updated to Sage's values (an IsaFlow edit of these fields was overwritten)");
    }
    return b.commitUnconfirmed ? line(b, 'commit unconfirmed') + updates(dryOf(b), "may have been updated to Sage's values (check the books)") : '';
  }).join('');
  const failed = err.batches.failed.map((b) => `${line(b, 'failed, nothing written')}: ${cut(b.error)}`).join('');
  return `${why}\nthe live run may already have committed some batches before this error: check the books (or run again without --live: a dry run lists what is there and what differs); a re-run resumes.${committed}${failed}`;
}

/**
 * The CLI's exit code for an error: 2 = refused or failed to start, nothing written; 4 = the run stopped AFTER its live phase started, so
 * batches may have been committed (the message lists them). 1 and 3 are the run's own results (see run.ts).
 */
export function exitCodeForError(err: unknown): 2 | 4 {
  return err instanceof MigrationStopped && err.liveStarted ? 4 : 2;
}
