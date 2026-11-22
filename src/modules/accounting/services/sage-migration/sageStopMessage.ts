/**
 * What the CLI says when the run stops on an error. Only an error after the live phase actually STARTED (MigrationStopped) says the run may
 * have committed, and lists the batches that did; any other error wrote nothing and says only why. PURE.
 */
import { MigrationStopped } from './sageMigrationStopped';

export function stopMessage(err: unknown): string {
  const why = `sage migration stopped: ${err instanceof Error ? err.message : String(err)}`;
  if (!(err instanceof MigrationStopped) || !err.liveStarted) return why;
  const committed = err.committed.filter((b) => b.status === 'ok').map((b) => `\ncommitted: ${b.entity} batch ${b.n} (${b.key})`).join('');
  return `${why}\nthe live run may already have committed some batches before this error: check the books (or run again without --live: a dry run lists what is there and what differs); a re-run resumes.${committed}`;
}
