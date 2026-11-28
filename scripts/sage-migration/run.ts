/**
 * Sage migration runner (Phase D). LOCAL DATABASES ONLY: it refuses to start unless DATABASE_URL (and any other database URL in
 * the environment) is a local throwaway database (src/modules/accounting/services/sage-migration/localGuard.ts).
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/isaflow_test bun --no-env-file scripts/sage-migration/run.ts \
 *     --company <uuid> --user <uuid> --file <export.json> [--live] [--report <file>] [--skip-budget-check] [--po-gl-account <uuid>] [--allow-refusals] [--allow-differences] [--run-tag <text>] \
 *     [--expect-items N] [--expect-pos N] [--expect-po-total 80950000.00]
 *
 * Without --live: the dry run only, nothing written. --live needs --expect-items and --expect-pos. --run-tag salts the batch keys, for a
 * deliberate fresh import after the rows of an earlier run were deleted (the registry would otherwise replay that run's answers). With --live: the dry run, then categories -> items -> purchase orders when
 * it is clean. --user must be an active member of --company (owner or admin to use --skip-budget-check). Exit 0 for a clean dry
 * run or a live run that booked every row it sent, whose --expect-* figures match what was sent (dry run) or booked (live) and
 * which refused no row (unless --allow-refusals) and found no PO or owned item differing from the books (unless --allow-differences); 1 for anything else; 2 for a refused start (nothing written), 4 when the run stopped on an error AFTER its live phase started, a live batch's COMMIT that did not answer among them (the run stops at that batch; batches may be committed: the message lists them; check the books, a re-run resumes), 3 when the run was otherwise ok but --report could not be written (the summary is printed first; a 1 stays).
 * --report must name a path that does not exist: once the arguments are checked and the export is read, the run creates it and writes only
 * that file, through its held descriptor (scripts/sage-migration/runReport.ts). SIGINT / SIGTERM / SIGHUP stop the run before its next
 * batch (in the dry run exit 2, nothing written; once the live phase started exit 4, a stop report in --report); a second one, an uncaught
 * error or an unhandled rejection ends it at once with a stop report of what is known (scripts/sage-migration/runEnd.ts: no batch and no
 * request after it); after a crash the exit first waits, at most 80 s, for the batch in flight to settle and writes its outcome into the
 * report (a second signal ends that wait), then up to 120 s for the console's readers. A closed
 * stdout or stderr (EPIPE) is no longer written and never ends the run. Named limits: SIGHUP is handled like SIGTERM, so `nohup` does
 * not keep a run going after a hangup (it stops before its next batch; run it under tmux / screen / systemd-run instead) (R19-2); an
 * exit-4 summary goes to stderr only, so with stderr closed and no --report the committed list reaches nobody: give --report (R19-7).
 * `--no-env-file` keeps bun from loading a .env.local that names the dev database (the guard would refuse it anyway). Format and mapping: docs/design/sage-migration-export-format.md.
 */
// FIRST, before any other module of the CLI runs (B29-2): fd 1 / fd 2's flags as found. Importing the logger touches process.stdout, and
// bun then makes fd 1 / 2 O_NONBLOCK, so the body (runMain.ts) is imported only after this is saved; its own imports may touch them.
import { saveFlags } from './runConsoleSys';

const restoreStartFlags = saveFlags();

/** The CLI (tests call it; `removeHandlers` removes its handlers when it returns, R18-3). */
export async function runCli(o: { removeHandlers?: boolean } = {}): Promise<void> {
  const body = await import('./runMain');
  return body.runCli(o, restoreStartFlags);
}

// Only when run as the CLI (bun's import.meta.main), never on import (tests call runCli).
if ((import.meta as { main?: boolean }).main) void runCli();
