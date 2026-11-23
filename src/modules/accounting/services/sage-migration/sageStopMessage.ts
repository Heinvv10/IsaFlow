/**
 * What the CLI says when the run stops on an error. Only an error after the live phase actually STARTED (MigrationStopped) says the run may
 * have committed, and lists the batches that did; any other error wrote nothing and says only why. PURE.
 */
import { MigrationStopped } from './sageMigrationStopped';

export function stopMessage(err: unknown): string {
  const why = `sage migration stopped: ${err instanceof Error ? err.message : String(err)}`;
  if (!(err instanceof MigrationStopped) || !err.liveStarted) return why;
  const line = (b: { entity: string; n: number; key: string }, what: string) => `\n${what}: ${b.entity} batch ${b.n} (${b.key})`;
  const committed = err.committed.map((b) => (b.status === 'ok' ? line(b, b.allRowsAlreadyPresent ? 'answered ok, nothing new written (its rows were already there)' : 'committed') : b.commitUnconfirmed ? line(b, 'commit unconfirmed') : '')).join('');
  return `${why}\nthe live run may already have committed some batches before this error: check the books (or run again without --live: a dry run lists what is there and what differs); a re-run resumes.${committed}`;
}

/**
 * The CLI's exit code for an error: 2 = refused or failed to start, nothing written; 4 = the run stopped AFTER its live phase started, so
 * batches may have been committed (the message lists them). 1 and 3 are the run's own results (see run.ts).
 */
export function exitCodeForError(err: unknown): 2 | 4 {
  return err instanceof MigrationStopped && err.liveStarted ? 4 : 2;
}
