/**
 * What the CLI says when the run stops on an error. Only an error after the live phase actually STARTED (MigrationStopped) says the run may
 * have committed, and lists, batch by batch, what it did to the books:
 *   - committed (with the owned items / categories its LIVE answer says it put back to Sage's values: those IsaFlow edits are overwritten,
 *     and a dry run after the stop no longer shows them; rows the books check found changed since are said so), answered ok but wrote
 *     nothing, or answered from a stored answer (the registry said so) and wrote nothing;
 *   - commit unconfirmed (with what its live answer says it may have updated; the dry run's answer only when there is no live one);
 *   - failed, nothing written (the request rolled back, or the tool refused before writing), with the reason.
 * Any other error wrote nothing and says only why. PURE.
 */
import { CONSOLE_ERROR_CHARS } from './sageReportSummary';
import { updatesOf } from './sageDifferences';
import { writtenWording } from './sageRowWording';
import { MigrationStopped } from './sageMigrationStopped';
import type { BatchReport } from './sageMigrationTypes';

const cut = (text: string | null): string =>
  text === null ? 'no reason given' : text.length <= CONSOLE_ERROR_CHARS ? text : `${text.slice(0, CONSOLE_ERROR_CHARS)} ... (${text.length} characters)`;
/** The rows a batch's answer says it updated, one line each, worded by `word`. */
const updates = (b: BatchReport | undefined, word: (name: string) => string): string =>
  (b ? updatesOf(b) : []).map((u) => `\n  ${word(u.name)}: ${u.kind} ${u.name} (${u.changed.join(', ') || 'no detail given'})`).join('');

export function stopMessage(err: unknown): string {
  const why = `sage migration stopped: ${err instanceof Error ? err.message : String(err)}`;
  if (!(err instanceof MigrationStopped) || !err.liveStarted) return why;
  const line = (b: BatchReport, what: string) => `\n${what}: ${b.entity} batch ${b.n} (${b.key})`;
  const dryOf = (b: BatchReport) => err.batches.dryRun.find((d) => d.entity === b.entity && d.n === b.n);
  const committed = err.committed.map((b) => {
    // From the LIVE answer of each batch (sageRowWording). "Nothing written" only where the registry said it served a stored answer.
    if (b.replayed) {
      return b.rowsAbsent > 0 ? line(b, 'replayed: rows absent, nothing written (use --run-tag for a fresh import)') : line(b, 'answered from a stored answer, nothing written');
    }
    if (b.commitUnconfirmed) {
      // The live answer the request had before its COMMIT; only without one, the dry run's answer for that batch (said so).
      return line(b, 'commit unconfirmed') + (b.toolReported !== null
        ? updates(b, () => "may have been updated to Sage's values (check the books)")
        : updates(dryOf(b), () => "may have been updated to Sage's values (from the dry run's answer: check the books)"));
    }
    if (b.status !== 'ok' && !b.changedAfterCommit) return '';
    if (b.allRowsAlreadyPresent && !b.changedAfterCommit) return line(b, 'answered ok, nothing new written (its rows were already there)');
    const changed = b.changedAfterCommit ? ` (then changed or removed in the books by another writer: ${(b.changedRows ?? []).join(', ') || 'see the books'}: check)` : '';
    return line(b, 'committed') + changed + updates(b, (name) => writtenWording(b, name));
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
