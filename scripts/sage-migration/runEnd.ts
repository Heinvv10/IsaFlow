/**
 * How the CLI's run ends (round 18 decision, R29-1, R29-2, R29-9, B29-4, R30-1, B30-2). One state, RunState.ended, set synchronously before
 * any wait by every end: terminate (a second signal, an uncaught error, an unhandled rejection) and the CLI's own exits. Once it is set:
 *   - shouldStop answers a stop, so no further batch is sent (the runner asks it before every batch, dry and live);
 *   - the runner's sessions refuse to start a request (RunEndedError, nothing sent): withToolSession reads `ended`;
 *   - main does nothing more after terminate (`endedAtOnce`): no summary, no report write, no exit code;
 *   - the stop report and the console list are what was known at that moment, the batch in flight then listed commit unconfirmed.
 * A crash then waits, bounded (IN_FLIGHT_WAIT_MS), for that batch to settle (finished or lost, by the usual rules), says its outcome and
 * writes it into the report; a signal never waits for it. The exit then waits for the console (runConsole.ts, its own ceiling). Only a
 * second SIGNAL ends either wait at once (exitNow); a stray error while it waits is logged and changes nothing, so the stop message is
 * never cut by it.
 */
import { log } from '../../src/lib/logger';
import { exitCodeForError, stopMessage } from '../../src/modules/accounting/services/sage-migration/sageStopMessage';
import type { BatchReport } from '../../src/modules/accounting/services/sage-migration/sageMigrationTypes';
import { type OwnedReport, stopReportBody } from './runReport';
import { SAGE_QUERY_TIMEOUT_MS } from '../../src/modules/accounting/services/sage-migration/sageTimeouts';
import { RunState } from './runState';
import { cliConsole, codeOf, exitAfterConsole, exitNow, exitPending, say, told } from './runConsole';

/** The module's run: runCli runs once per process (the CLI; each test re-imports the module) (R19-5). */
export const cli = {
  /** The --report file this run created (runReport.ts); every exit after its create leaves a report in it. */
  owned: null as OwnedReport | null,
  /** The --report asked for, while it does not exist yet: a refusal then says it was not created. */
  reportAsked: undefined as string | undefined,
  /** The create failed after it made the file, and the file could not be removed (R18-4). */
  reportLeft: false,
  state: new RunState(),
  /** The first SIGINT / SIGTERM / SIGHUP seen. */
  stopSignal: null as string | null,
  /** terminate ended the run: main's continuation must not say, write or decide anything (R29-1). */
  endedAtOnce: false,
  /** The exit code that end decided (a further signal exits with it). */
  endCode: undefined as number | undefined,
  /** That end's exit, once asked (main's continuation waits for it, never asks one of its own). */
  ending: Promise.resolve() as Promise<void>,
  /** While a crash waits for the batch in flight: when that wait ends (Date.now ms), so a first signal says what it waits for (B31-3). */
  inFlightUntil: null as number | null,
};

/**
 * A stop report through the held descriptor. If it cannot be written, once more, small, through the same descriptor (B18-5), so a body
 * written in part is replaced when it can be (a failing disk can still leave a mix: runReport.ts); the exit code is not changed by it. `keepOpen`: a batch was in flight, its outcome may still be written.
 */
export function leaveStopReport(err: unknown, exitCode: number, keepOpen = false): void {
  const owned = cli.owned;
  if (!owned) return;
  const why = owned.write(stopReportBody(err));
  if (why) {
    say(why);
    const again = owned.write({ status: 'stop_report_not_written', exitCode, why });
    if (again) say(again); // what the file then holds is the console's final word at the exit (round 34)
  }
  if (!keepOpen) owned.close();
}

/** What a stop asked for says, before every batch: the run ended, or a first signal came (R19-6: before the live phase, nothing written). */
export const shouldStop = (): string | null => {
  const s = cli.state;
  if (s.ended !== null) return `the run had ended (${s.ended}): no further batch is sent${s.liveStarted ? '' : '; nothing was written to the books'}`;
  return cli.stopSignal === null ? null : `stopped by ${cli.stopSignal}: no further batch is sent${s.liveStarted ? '' : '; nothing was written to the books'}`;
};

const settledWording = (b: BatchReport): string => {
  if (b.commitUnconfirmed) return 'did not have its COMMIT confirmed: check the books';
  if (b.status === 'ok') return b.allRowsAlreadyPresent ? 'answered ok, nothing new written' : 'committed';
  return `failed, nothing written (${b.error ?? 'no reason given'})`;
};

/**
 * A rewrite of the stop report (the batch in flight settled, R30-4, B31-2, B32-1), then the file closed; returns whether it was written,
 * and the lines that say what became of the report otherwise. OwnedReport.write never empties the file first, and `holds` says which body
 * it holds whole: the first stop report is kept only when the file holds it; otherwise (torn, or still the placeholder or the note, the
 * first stop report itself not written) the stop report as known at the end is written, failing that the small "not written" body. Each
 * line says what was done and what the file holds, never what is about to be tried.
 */
function rewriteStopReport(err: unknown, first: unknown, exitCode: number): { written: boolean; lines: string[] } {
  const owned = cli.owned;
  if (!owned) return { written: false, lines: [] };
  try {
    const hadFirst = owned.intact && owned.holds === 'stopped';
    const why = owned.write(stopReportBody(err));
    if (why === null) return { written: true, lines: [] };
    const listed = '(it lists that batch commit unconfirmed)';
    if (owned.intact && owned.holds === 'stopped') return { written: false, lines: [`${why}: the stop report written before is kept ${listed}`] };
    const back = owned.write(stopReportBody(first));
    if (back === null) {
      return { written: false, lines: [`${why}: the stop report ${hadFirst ? 'written before was written back' : 'as known when the run ended was written in its place'} ${listed}`] };
    }
    const small = owned.write({ status: 'stop_report_not_written', exitCode, why: back });
    return { written: false, lines: [why, back, ...(small === null ? [] : [small])] }; // what the file holds: the final word at the exit
  } finally {
    owned.close();
  }
}

/**
 * How long a crash waits for the batch in flight to settle (R30-1). Each request of the batch is bounded by SAGE_QUERY_TIMEOUT_MS, but its
 * connect, lock, statements and COMMIT run one after another, so the batch as a whole is not: past this wait it stays commit unconfirmed.
 * The worst case from a crash to the exit is this wait, then the console's CONSOLE_EXIT_CEILING_MS (80 s + 120 s).
 */
export const IN_FLIGHT_WAIT_MS = SAGE_QUERY_TIMEOUT_MS + 5_000;

/**
 * The one end AT ONCE: a second signal, an uncaught error or an unhandled rejection. `signal`: it came from a signal.
 *   - A signal ends the process at once too (B30-2): the stop report is written, then exitNow (what the console still had is cut, and
 *     that is said where it can be). The batch in flight is listed commit unconfirmed.
 *   - A crash waits, bounded (IN_FLIGHT_WAIT_MS), for the batch in flight to settle (R30-1), whatever the console's reader does, says and
 *     writes its outcome, then exits once the console is written. A first signal during that wait says what it waits for; a second one
 *     ends it at once (B31-3), that batch then staying commit unconfirmed.
 */
export function terminate(why: string, signal: boolean): void {
  const s = cli.state;
  if (cli.endedAtOnce || exitPending()) {
    if (signal) { exitNow(cli.endCode); return; } // a further signal while it ends: at once, its code unchanged (B28-1)
    log.warn('sage migration: an error came while the run was ending; its exit and its report stand', { why }, 'sage-migration');
    return; // R29-2: never cuts the stop message
  }
  if (s.finished) {
    if (signal) { exitNow(); return; } // R29-9: the first signal said it had finished; this one ends it at once
    say(`${why}: the run had finished; its report and exit code stand`);
    void exitAfterConsole(undefined); // process.exit() keeps process.exitCode
    return;
  }
  // FIRST, synchronously: from here no batch is sent and no request starts (R29-1).
  const reason = s.liveStarted ? why : `${why}; nothing was written to the books (the live phase had not started)`;
  s.end(why);
  cli.endedAtOnce = true;
  const err = s.stoppedAtOnce(reason);
  const code = exitCodeForError(err);
  cli.endCode = code;
  say(stopMessage(err));
  const flying = s.inFlightAtEnd;
  leaveStopReport(err, code, flying !== null && !signal);
  if (signal) { exitNow(code); return; }
  if (flying === null) { cli.ending = exitAfterConsole(code); return; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  cli.inFlightUntil = Date.now() + IN_FLIGHT_WAIT_MS;
  /** The wait is over: the one that came first is the only one heard (L4: a late settle is neither said nor written). */
  const over = (): void => { clearTimeout(timer); s.onSettledAfterEnd = null; cli.inFlightUntil = null; };
  cli.ending = new Promise<void>((resolve) => {
    // L1: whatever saying or writing it does, the wait ends (resolve), so the exit always follows.
    s.onSettledAfterEnd = (b) => {
      try {
        over();
        const rewrite = rewriteStopReport(s.stoppedAtOnce(reason), err, code); // now with that batch as it settled, then closed
        say(`the batch in flight when the run ended, ${b.entity} batch ${b.n} (${b.key}), then ${settledWording(b)}; no batch followed it${rewrite.written ? ': the report says so' : ''}`);
        for (const line of rewrite.lines) say(line);
      } catch (e) {
        log.error('sage migration: the batch in flight settled, but saying or writing it failed', { error: told(e) }, 'sage-migration');
      } finally {
        resolve();
      }
    };
    timer = setTimeout(() => {
      try {
        over();
        say(`the batch in flight when the run ended, ${flying.entity} batch ${flying.n} (${flying.key}), did not settle within ${IN_FLIGHT_WAIT_MS / 1000} s: it stays commit unconfirmed: check the books`);
        cli.owned?.close();
      } catch (e) {
        log.error('sage migration: the wait for the batch in flight timed out, but saying or closing it failed', { error: told(e) }, 'sage-migration'); // L4
      } finally {
        resolve();
      }
    }, IN_FLIGHT_WAIT_MS);
  }).then(() => exitAfterConsole(code));
}

/**
 * The first SIGINT / SIGTERM / SIGHUP asks the run to stop before its next batch, through the usual stop. A second one ends it at once.
 * Installed by runCli only, never on import (R18-3). Returns what removes them (tests only).
 */
export function installHandlers(): () => void {
  const signal = (sig: NodeJS.Signals) => () => {
    if (cli.stopSignal !== null) return terminate(`stopped at once by a second signal (${sig})`, true);
    cli.stopSignal = sig;
    // B31-3: a crash waits for the batch in flight: a first signal says that, and that a second one ends the wait.
    if (cli.inFlightUntil !== null) {
      const left = Math.max(1, Math.ceil((cli.inFlightUntil - Date.now()) / 1000));
      return say(`${sig}: the run has already stopped; it waits up to ${left} s more for the batch in flight to settle (send it again to exit at once: that batch then stays commit unconfirmed)`);
    }
    // B29-4: the run has stopped already, its message waits for a reader: say so, never "stops before its next batch".
    if (cli.endedAtOnce || exitPending()) return say(`${sig}: the run has already stopped; its stop message is still being written (send it again to exit at once)`);
    // After the run returned (its report written or being written, the pool closing) there is nothing left to stop (B20-3).
    if (cli.state.finished) return say(`${sig}: the run had finished; its report and exit code stand`);
    say(cli.state.liveStarted
      ? `${sig}: the live run stops before its next batch, if one remains; what it committed is then listed (send it again to stop at once)`
      : `${sig}: the run stops before its next batch, if one remains; nothing is written to the books (send it again to stop at once)`);
  };
  const crash = (kind: string) => (e: unknown) => terminate(`${kind}: ${told(e)}`, false); // B35-2: a hostile value cannot throw here
  // A write through the stream itself failed: said once (B19-3), the stream not written again; the run goes on.
  const stream = (name: 'stdout' | 'stderr') => (e: unknown) => { const code = codeOf(e); cliConsole.markGone(name, typeof code === 'string' ? code : told(e)); }; // R36-3
  type Listener = (...a: unknown[]) => void;
  const on: Array<[NodeJS.EventEmitter, string, Listener]> = [
    ...(['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig): [NodeJS.EventEmitter, string, Listener] => [process, sig, signal(sig)]),
    [process, 'uncaughtException', crash('an uncaught error ended the run')], [process, 'unhandledRejection', crash('an unhandled rejection ended the run')],
    [process.stdout, 'error', stream('stdout') as Listener], [process.stderr, 'error', stream('stderr') as Listener],
  ];
  for (const [em, ev, fn] of on) em.on(ev, fn);
  return () => { for (const [em, ev, fn] of on) em.off(ev, fn); };
}
