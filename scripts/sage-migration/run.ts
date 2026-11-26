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
 * error or an unhandled rejection ends it at once with a stop report of what is known (scripts/sage-migration/runState.ts). A closed
 * stdout or stderr (EPIPE) is no longer written and never ends the run. Named limits: SIGHUP is handled like SIGTERM, so `nohup` does
 * not keep a run going after a hangup (it stops before its next batch; run it under tmux / screen / systemd-run instead) (R19-2); an
 * exit-4 summary goes to stderr only, so with stderr closed and no --report the committed list reaches nobody: give --report (R19-7).
 * `--no-env-file` keeps bun from loading a .env.local that names the dev database (the guard would refuse it anyway). Format and mapping: docs/design/sage-migration-export-format.md.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { UUID_RE } from '../../src/lib/validation';
import { RUN_TAG } from '../../src/modules/accounting/services/sage-migration/sageBatches';
import { assertLocalDatabase } from '../../src/modules/accounting/services/sage-migration/localGuard';
import { parseSageExport } from '../../src/modules/accounting/services/sage-migration/sageExportParser';
import { runSageMigration } from '../../src/modules/accounting/services/sage-migration/sageMigrationRunner';
import { SAGE_POOL_END_TIMEOUT_MS, sagePoolConfig } from '../../src/modules/accounting/services/sage-migration/sageTimeouts';
import type { ParsedExport } from '../../src/modules/accounting/services/sage-migration/sageExportTypes';
import { exitCodeForError, stopMessage } from '../../src/modules/accounting/services/sage-migration/sageStopMessage';
import { checkReportArgs, exitAfterReportFailure, OwnedReport, stopReportBody, summarize } from './runReport';
import { RunState } from './runState';
import { cliConsole, say } from './runConsole';

/**
 * The console (runConsole.ts): every line written synchronously, so a process.exit after it cannot drop it (R27-2). A stream whose reader
 * went away (`| head`, a dead `tee` or log shipper: EPIPE) is no longer written, and never kills the run (round 18, B18-2): the run goes
 * on to its own end, its report in --report.
 */
const stdoutClosed = (why: string) => say(`stdout is closed (${why}): the summary is not printed there; --report holds the run's report`);
const out = (s: string) => { const r = cliConsole.write('stdout', `${s}\n`); if (typeof r === 'object') stdoutClosed(r.gone); };
/**
 * The --report file this run created (runReport.ts: a path that did not exist, created exclusively once every argument is checked and the
 * export is read, before the first database step). Every exit after that leaves a report in it, written through its held descriptor: the
 * stop report of a stop or a refusal, the run's own report at the end. A refusal before it exists writes nothing anywhere.
 */
let owned: OwnedReport | null = null;
/** The --report asked for, while it does not exist yet: a refusal then says it was not created. */
let reportAsked: string | undefined;
/** The create failed after it made the file, and the file could not be removed (R18-4): a refusal must not say "not created". */
let reportLeft = false;
/**
 * What the run did so far (the runner's onProgress): a stop at once says it. This state and the variables above are the module's: runCli
 * runs once per process (the CLI; each test re-imports the module) (R19-5).
 */
const state = new RunState();
/**
 * A stop report through the held descriptor, then the file is closed (a second report is refused). If it cannot be written, once more,
 * small, through the same descriptor (B18-5), so the file is never left truncated; the exit code is not changed by it.
 */
const leaveStopReport = (err: unknown, exitCode: number): void => {
  if (!owned) return;
  const why = owned.write(stopReportBody(err));
  if (why) {
    say(why);
    const again = owned.write({ status: 'stop_report_not_written', exitCode, why });
    if (again) say(again);
  }
  owned.close();
};
/**
 * The note on a refusal before --report exists. Only main's catch can need it: main runs without an await up to the create, so no signal
 * or crash handler (terminate) runs while --report is asked for but not created.
 */
const notCreated = () => {
  if (reportLeft) return ` (nothing written to the books; --report ${reportAsked} was created but could not be written or removed: delete it)`;
  return owned === null && reportAsked !== undefined ? ` (nothing written; --report ${reportAsked} was not created by this run)` : '';
};
/**
 * A refused start: thrown, so every exit goes through main's one catch (the message, a stop report once --report exists, exit 2: nothing
 * written to the books).
 */
class RefusedStart extends Error {}
const fail: (s: string) => never = (s) => { throw new RefusedStart(s); };

/**
 * The one end AT ONCE (round 18 decision): a second signal, an uncaught error or an unhandled rejection. Its stop report is built from
 * what the run reported so far (RunState: the batches recorded, the one in flight as commit unconfirmed), written through the held
 * descriptor; exit 4 once the live phase started, else 2 (nothing written to the books). A run that already finished keeps its exit code.
 */
function terminate(why: string): void {
  if (state.finished) {
    say(`${why}: the run had finished; its report and exit code stand`);
    process.exit();
    return;
  }
  const err = state.stoppedAtOnce(state.liveStarted ? why : `${why}; nothing was written to the books (the live phase had not started)`);
  const code = exitCodeForError(err);
  say(stopMessage(err));
  leaveStopReport(err, code);
  process.exit(code);
}

/**
 * The first SIGINT / SIGTERM / SIGHUP asks the run to stop before its next batch (dry or live; the runner asks shouldStop), so it stops
 * through the usual path: in the dry run a refused start (exit 2), in the live phase a stop report listing what was committed (exit 4). A
 * second one ends it at once (terminate). Installed by runCli only, never on import (R18-3).
 */
let stopSignal: string | null = null;
/** Installs the handlers; returns what removes them (tests only: the CLI keeps them until it exits). */
function installHandlers(): () => void {
  const signal = (sig: NodeJS.Signals) => () => {
    if (stopSignal !== null) return terminate(`stopped at once by a second signal (${sig})`);
    stopSignal = sig;
    // After the run returned (its report written or being written, the pool closing) there is nothing left to stop (B20-3).
    if (state.finished) return say(`${sig}: the run had finished; its report and exit code stand`);
    say(state.liveStarted
      ? `${sig}: the live run stops before its next batch, if one remains; what it committed is then listed (send it again to stop at once)`
      : `${sig}: the run stops before its next batch, if one remains; nothing is written to the books (send it again to stop at once)`);
  };
  const crash = (kind: string) => (e: unknown) => terminate(`${kind}: ${e instanceof Error ? e.message : String(e)}`);
  const stream = (name: 'stdout' | 'stderr') => (e: NodeJS.ErrnoException) => {
    // A write through the stream itself (the logger's) failed: said once (B19-3), the stream not written again; the run goes on.
    if (cliConsole.gone[name]) return;
    cliConsole.markGone(name);
    if (name === 'stdout') stdoutClosed(e.code ?? e.message);
  };
  type Listener = (...a: unknown[]) => void;
  const on: Array<[NodeJS.EventEmitter, string, Listener]> = [
    ...(['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig): [NodeJS.EventEmitter, string, Listener] => [process, sig, signal(sig)]),
    [process, 'uncaughtException', crash('an uncaught error ended the run')], [process, 'unhandledRejection', crash('an unhandled rejection ended the run')],
    [process.stdout, 'error', stream('stdout') as Listener], [process.stderr, 'error', stream('stderr') as Listener],
  ];
  for (const [em, ev, fn] of on) em.on(ev, fn);
  return () => { for (const [em, ev, fn] of on) em.off(ev, fn); };
}

/** "80950000.00" -> 8095000000 cents, exactly (no float). */
function cents(text: string): number {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return fail(`not an amount: ${text}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
const parseCli = () => parseArgs({
  options: {
    company: { type: 'string' }, user: { type: 'string' }, file: { type: 'string' }, report: { type: 'string' },
    live: { type: 'boolean', default: false }, 'skip-budget-check': { type: 'boolean', default: false }, 'po-gl-account': { type: 'string' }, 'allow-refusals': { type: 'boolean', default: false }, 'run-tag': { type: 'string' }, 'allow-differences': { type: 'boolean', default: false },
    'expect-items': { type: 'string' }, 'expect-pos': { type: 'string' }, 'expect-po-total': { type: 'string' },
  },
  strict: true,
});

const count = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) return fail(`not a count: ${text}`);
  return Number(text);
};

async function main(): Promise<void> {
  let parsedArgs: ReturnType<typeof parseCli>;
  try { parsedArgs = parseCli(); } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
  const { values } = parsedArgs;
  const target = checkReportArgs(process.argv.slice(2), values.report);
  if (!target.ok) fail(`${target.why} (nothing written)`);
  reportAsked = target.path;
  // Every check that needs no database comes first (round 17): a refusal here writes nothing anywhere, --report not even created.
  try { assertLocalDatabase(); } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
  if (!values.company || !UUID_RE.test(values.company)) fail('--company <uuid> is required');
  if (!values.user || !UUID_RE.test(values.user)) fail('--user <uuid> is required');
  if (!values.file) fail('--file <export.json> is required');
  if (values['run-tag'] !== undefined && !RUN_TAG.test(values['run-tag'])) fail('--run-tag must be 1-32 letters, digits, - or _');
  if (values.live && (values['expect-items'] === undefined || values['expect-pos'] === undefined)) {
    fail('--live needs --expect-items and --expect-pos (the counts you expect to be booked, 0 if none), so an export that lost a container cannot pass unnoticed');
  }
  if (values['po-gl-account'] !== undefined && !UUID_RE.test(values['po-gl-account'])) fail('--po-gl-account must be an expense account uuid');
  const expect = {
    items: count(values['expect-items']), purchaseOrders: count(values['expect-pos']),
    purchaseOrderTotalCents: values['expect-po-total'] === undefined ? undefined : cents(values['expect-po-total']),
  };
  let parsed: ParsedExport;
  // An export that cannot be read or parsed is a refused start, said so (R18-5), before --report is created.
  try { parsed = parseSageExport(JSON.parse(readFileSync(values.file!, 'utf8'))); } catch (err) { fail(`--file ${values.file} cannot be used: ${err instanceof Error ? err.message : String(err)}`); }
  // --report is created exclusively now, before the first database step: a path that exists is never written, and nothing else is.
  if (target.path !== undefined) {
    const created = OwnedReport.create(target.path);
    if (!(created instanceof OwnedReport)) { reportLeft = created.left === true; fail(created.why); } else owned = created;
  }
  // Round 25: every connection kept alive and every query bounded client-side (sagePoolConfig), the run lock's included.
  const pool = new pg.Pool(sagePoolConfig(process.env.DATABASE_URL));
  pool.on('error', (err) => say(`database pool error: ${err.message}`));
  openPool = pool; // ended by runCli AFTER the result (or the stop message) is out, and bounded (B26-1)
  {
    const report = await runSageMigration(pool, parsed, {
      companyId: values.company!.toLowerCase(), userId: values.user!.toLowerCase(), live: values.live, skipBudgetCheck: values['skip-budget-check'], poGlAccountId: values['po-gl-account']?.toLowerCase(), runTag: values['run-tag'], allowRefusals: values['allow-refusals'] === true, allowDifferences: values['allow-differences'] === true,
      expect,
      // Before the live phase the answer says nothing was written (R19-6): the stop is then a refused start.
      shouldStop: () => (stopSignal === null ? null : `stopped by ${stopSignal}: no further batch is sent${state.liveStarted ? '' : '; nothing was written to the books'}`),
      onProgress: state.onProgress,
      onNotice: say, // a wait with no answer (and who blocks it), a run lock release not confirmed: never silent (round 25)
    });
    // From here to the report's write there is no await, so no signal or crash handler runs in between: an end at once after it changes
    // nothing (the run's own report is written; its exit code stands).
    state.finished = true;
    // The summary is printed FIRST: a committed run must always tell what it did, whatever happens to the report file.
    const { lines, code } = summarize(report, values['allow-refusals'] === true, values['allow-differences'] === true);
    for (const line of lines) (code === 4 ? say(line) : out(line));
    process.exitCode = code;
    if (owned) {
      const why = owned.write(report);
      if (why) {
        // The summary above says what the run did; this says what happened to the report. A 1 or a 4 is never hidden by it (0 -> 3 only).
        const next = exitAfterReportFailure(code);
        say(next === 3 ? `the run finished (exit 0 without this) but the report was not written: ${why}` : `the report was not written: ${why} (the exit code stays ${code}: see the summary above)`);
        process.exitCode = next;
        // Once more through the same descriptor, small: so the file does not keep saying "running" (R17-4).
        const again = owned.write({ status: 'report_not_written', exitCode: next, why });
        if (again) say(again);
      }
      owned.close();
    }
    // A signal that came after the run's last stop check (during the last batch, its check, or a run with none): the run finished, and says
    // so last, with the exit code it ends with (B19-2, R19-3, R20-3).
    if (stopSignal !== null) say(`${stopSignal} came after the run's last stop check: the run finished (exit ${process.exitCode})`);
  }
}

/** The pool of the run, ended by runCli once everything is said. */
let openPool: pg.Pool | null = null;
/**
 * Ends the pool, bounded (B26-1): a pool that fails to close, or does not finish within SAGE_POOL_END_TIMEOUT_MS (a connect to a server
 * that never answers), cannot change what the run did nor its exit code (R17-7): it is said, and the process exits with the run's code.
 */
async function endPool(): Promise<void> {
  const pool = openPool;
  openPool = null;
  if (pool === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    pool.end().then(() => 'ended', (err: unknown) => { say(`closing the database pool failed: ${err instanceof Error ? err.message : String(err)}`); return 'failed'; }),
    new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), SAGE_POOL_END_TIMEOUT_MS); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  if (outcome !== 'timeout') return;
  say(`closing the database pool did not finish within ${SAGE_POOL_END_TIMEOUT_MS / 1000} s: the run's result above stands (exit ${process.exitCode ?? 0})`);
  process.exit(process.exitCode ?? 0);
}

/**
 * The CLI, every abnormal end through main's catch or terminate. Its handlers stay installed until the process exits: a closed stdout
 * found by the summary's last write (EPIPE comes on a later turn), a signal or a crash while the pool closes must still go through them
 * (terminate keeps a finished run's exit code). `removeHandlers` (tests, R18-3) removes them when it returns, so they never outlive it.
 */
export async function runCli(o: { removeHandlers?: boolean } = {}): Promise<void> {
  const uninstall = installHandlers();
  try {
    await main();
    await endPool(); // after the summary, the report and the closing line: a pool that does not close cannot swallow them
  } catch (err) {
    // Said BEFORE the pool is ended (B26-1): the process exits here, so a pool that never ends cannot keep the stop message unsaid.
    const code = exitCodeForError(err);
    say(`${err instanceof RefusedStart ? err.message : stopMessage(err)}${notCreated()}`);
    leaveStopReport(err, code); // every other exit path after the create (a stop, a refusal, a summary that failed after a dry run) leaves a stop report
    process.exit(code);
  } finally {
    if (o.removeHandlers === true) uninstall();
  }
}

// Only when run as the CLI (bun's import.meta.main), never on import (tests call runCli).
if ((import.meta as { main?: boolean }).main) void runCli();
