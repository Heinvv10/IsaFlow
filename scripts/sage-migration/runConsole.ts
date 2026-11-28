/**
 * The CLI's console (R27-2, R28-1, R28-6, R28-7, B28-1, R29-2..4). bun's process.stderr.write keeps what a pipe did not take in its own
 * buffer, and process.exit drops it: a reader that lagged got a stop message cut mid-line. So every line the CLI says goes through this
 * console (its queues and budgets: runConsoleQueue.ts):
 *   - written with fs.writeSync to fd 1 or 2, at once while the pipe takes it;
 *   - what a full pipe does not take (EAGAIN) is queued per stream and retried on a timer, so the event loop keeps running (timers, the
 *     run lock's keepalive, a second signal) while a reader lags;
 *   - each stream has its own budget, CONSOLE_WAIT_MS of NO PROGRESS (a Date.now deadline, reset by every byte written): a stalled stdout
 *     never costs stderr its time; one shared queue and budget when fd 1 and fd 2 are one file (2>&1);
 *   - a stream with no progress for that long, or that fails (EPIPE, ENOSPC), is given up: the rest of its output is dropped, and that is
 *     said on the other stream when it is a different, writable file (`onGiveUp`); the exit code is never changed by it;
 *   - the CLI exits only once both streams are drained or given up (`exitAfterConsole`, asked once: a later ask keeps the first code and
 *     waits the same wait), and at most CONSOLE_EXIT_CEILING_MS after the first ask (a natural end's included), whatever the progress;
 *   - only a second SIGNAL ends it at once (`exitNow`): what is cut is said on the other stream when it can be (B29-4);
 *   - those notices say only where --report is. A line about a report write says what that write did, after it (the rewrite after the
 *     batch in flight settled is the file's last write: it is closed then). What the file holds at the end is the one final word, said at
 *     every end after the file's last write, tried on every stream that may take it (round 34, B35-1: `sayFinalWord`).
 * fd 1 / fd 2's O_NONBLOCK flags are put back as found, and process.*.write restored, when the CLI exits or ends by itself (runConsoleSys.ts,
 * B29-2, R29-8; its named limits: pipes shared with other programs, SIGKILL and unhandled signals, B30-1/3/4).
 * A pipe holds little (8-64 KiB on velo): a large run should give --report.
 */
import { blockingFds, captureProcessStreams, sameFile, saveFlags, told, writeNow } from './runConsoleSys';
import { Console, FD, type Stream } from './runConsoleQueue';

export { blockingFds, codeOf, told } from './runConsoleSys';
export { CONSOLE_WAIT_MS, Console, type ConsoleDeps, type Stream } from './runConsoleQueue';

/** The longest an exit waits for the console in all, progress or not (R29-4). */
export const CONSOLE_EXIT_CEILING_MS = 120_000;
const OTHER: Record<Stream, Stream> = { stdout: 'stderr', stderr: 'stdout' };

interface ConsoleSys {
  sameFile: () => boolean;
  blockingFds: () => number[];
  /** Routes the process's other writers through the console; returns what restores them. */
  capture: (c: Console) => () => void;
  /** Remembers fd 1 / 2's flags; returns what puts them back. */
  saveFlags: () => () => void;
  /** One try, no wait (the cut marker): the bytes taken, 0 when refused. */
  writeNow: (fd: number, text: string) => number;
  exit: (code?: number) => void;
  /** Runs `fn` when the process ends by itself too (no process.exit): the run's own natural end must put the process back as well. */
  onExit: (fn: () => void) => void;
}
const realSys: ConsoleSys = {
  sameFile, blockingFds, capture: captureProcessStreams, saveFlags, writeNow, exit: (code) => (code === undefined ? process.exit() : process.exit(code)),
  onExit: (fn) => { process.once('exit', fn); },
};

/** A pipe takes a write of at most this many bytes whole or not at all (POSIX PIPE_BUF; 4096 on Linux). */
const PIPE_BUF = 4096;
/** The first `n` bytes of `b` (B38-3): never cut inside a UTF-8 character (a continuation byte starts no character). */
const headBytes = (b: Buffer, n: number): Buffer => {
  let end = Math.max(0, Math.min(n, b.length));
  while (end > 0 && end < b.length && (b[end]! & 0xc0) === 0x80) end--;
  return b.subarray(0, end);
};
/** The last `n` bytes of `b` (none when n <= 0, B38-3), likewise starting on a character. */
const tailBytes = (b: Buffer, n: number): Buffer => {
  let start = b.length - Math.max(0, Math.min(n, b.length));
  while (start < b.length && (b[start]! & 0xc0) === 0x80) start++;
  return b.subarray(start);
};
/**
 * The final word within PIPE_BUF with room for its newline and a leading one (B37-3): a longer write to a pipe with less room is taken in
 * part, and the claim would be the part cut. Its over-long `part` (the --report path, or an error's text) is shortened in the line to its
 * last bytes, said as such, and the rest of the line (the claim) is kept whole. Cut by index, never by String.replace (B38-3: a `$&` in
 * the path is not a pattern here).
 */
const fitted = (line: string, part: string, what: 'path' | 'text'): string => {
  const room = PIPE_BUF - 2;
  if (Buffer.byteLength(line) <= room) return line;
  const at = part === '' ? -1 : line.indexOf(part);
  if (at < 0) return headBytes(Buffer.from(line), room).toString('utf8');
  const [before, after] = [line.slice(0, at), line.slice(at + part.length)];
  const note = ` (its ${what} shortened: ${Buffer.byteLength(part)} bytes)`;
  const keep = room - Buffer.byteLength(`${before}...${note}${after}`);
  const short = `${before}...${tailBytes(Buffer.from(part), keep).toString('utf8')}${note}${after}`;
  return Buffer.byteLength(short) <= room ? short : headBytes(Buffer.from(short), room).toString('utf8');
};

/** The run's --report as the console sees it (runReport.ts OwnedReport): where it is, and what it holds now. */
export interface ReportView { readonly path: string; finalWord(): string }

/** The console's CLI side, for one Console (the process's own; a test's). `sys` is replaced in tests only. */
export function consoleApi(c: Console, sys: ConsoleSys = realSys) {
  const say = (s: string): void => { c.write('stderr', `${s}\n`); };
  let exiting: { code: number | undefined; done: Promise<void> } | null = null;
  /** The run's --report, or null when none was given (or it was not created). */
  let report: () => ReportView | null = () => null;
  let finalSaid = false;
  let restore: Array<() => void> = [];
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  let ceilingPassed = false;
  let oneNotice = false; // both streams given up at the ceiling: one notice for both, not one per stream (L2)
  /** What a notice says of --report mid-run: where it is, never what it holds (round 34: the final word says that, at the exit). */
  const hint = (pipe: boolean): string => {
    const r = report();
    if (r !== null) return `--report ${r.path} is where the run's report is written`;
    return pipe ? 'give --report <path>: a pipe holds only a few KiB, and a large run says more' : 'give --report <path>: it always holds the whole report';
  };
  /**
   * Puts the process back as found, each restore on its own, never throwing (B33-2: the natural end's 'exit' listener too, whose throw
   * would turn its exit code to 1). Last pushed first, so the flags are put back LAST (B32-3): a failed restore's line (writeNow sets
   * O_NONBLOCK) comes before them, never after.
   */
  const putBack = (): void => {
    for (const r of restore.splice(0).reverse()) {
      try { r(); } catch (err) { sys.writeNow(2, `could not put the console back as found: ${told(err)}\n`); }
    }
  };
  /**
   * The one final word about --report (round 34, B33-1, B34-1, B35-1): what the file holds, asked at the exit, after its last write; said
   * once, one non-blocking try per stream until one takes it: the live streams first (stderr, else stdout; one whose lane has nothing
   * queued first), then those given up for a STALL (a stalled pipe still takes a short line), never one that failed (EPIPE, ENOSPC).
   * A stream whose lane has bytes queued, or that was cut, gets it on a line of its own. Silent only when every try was refused. Every end
   * comes here: an exit (leave: a drained console, the ceiling, a second signal) and a natural end (the 'exit' listener).
   */
  const sayFinalWord = (): void => {
    if (finalSaid) return;
    finalSaid = true;
    let line: string;
    try {
      const r = report();
      if (r === null) return;
      line = fitted(r.finalWord(), r.path, 'path');
    } catch (err) {
      const why = told(err); // read once: a value may tell differently each time
      line = fitted(`--report: what it holds could not be told (${why}): check the books`, why, 'text');
    }
    // R35-2: with 2>&1 the lane is shared, so what either stream queued counts.
    const queued = (st: Stream): number => (c.shared ? c.queuedBytes('stdout') + c.queuedBytes('stderr') : c.queuedBytes(st));
    const both = ['stderr', 'stdout'] as const;
    const live = both.filter((st) => !c.gone[st]).sort((a, b) => Number(queued(a) > 0) - Number(queued(b) > 0));
    const stalled = both.filter((st) => c.gone[st] && c.goneFor[st] !== 'error');
    const cut = (st: Stream): boolean => c.gone[st] || (c.shared && (c.gone.stdout || c.gone.stderr)); // its last bytes may be a cut line
    for (const st of [...live, ...stalled]) { // a stream never written may be gone: the next is tried when one refuses
      const prefix = cut(st) || queued(st) > 0 ? '\n' : '';
      const text = `${prefix}${line}\n`;
      const taken = sys.writeNow(FD[st], text);
      if (taken >= Buffer.byteLength(text)) return;
      // B36-2: part of the word taken: said; its fragment ends its line, nothing follows. R37-5: only the prefix taken: nothing was said.
      if (taken > prefix.length) { sys.writeNow(FD[st], '\n'); return; }
      if (c.shared) return; // R36-4: one file: the other fd is the very pipe that refused
    }
  };
  /** Says the final word, puts the process back, then exits, whatever a restore does (R30-5: the exit code is the contract). */
  const leave = (code: number | undefined): void => {
    clearTimeout(ceiling);
    try { sayFinalWord(); putBack(); } finally { sys.exit(code); }
  };
  const CEILING = `the exit waited ${CONSOLE_EXIT_CEILING_MS / 1000} s for its reader`;
  /**
   * Past the ceiling: the streams that still have bytes queued are given up. Both: one notice, on stderr (L2), best effort only (B32-2):
   * its reader is stalled too, so its pipe is usually full and the one try is refused; --report is what holds the run then. With 2>&1
   * (one file) none at all: it would go into the very pipe just given up.
   */
  const giveUpStalled = (): void => {
    const stalled = (['stdout', 'stderr'] as const).filter((st) => c.queuedBytes(st) > 0);
    oneNotice = stalled.length === 2;
    try { for (const st of stalled) c.markGone(st, CEILING, 'ceiling'); } finally { oneNotice = false; }
    if (stalled.length === 2 && !c.shared) sys.writeNow(FD.stderr, `\nstdout and stderr: ${CEILING}: the rest of what they were given was dropped; ${hint(true)}\n`);
  };
  /**
   * The total ceiling (R29-4, R30-2, R30-3): past it, only the streams that still have bytes queued are given up, so the "cut" notice is
   * said on the other stream (one try, no wait) while that is still alive. Armed ONCE, at the first ask (a natural end's or an exit's): a
   * later ask (an error after a natural end) waits only what is left of it, none once it has passed. Unref'd: it never keeps a process
   * that has nothing left to write alive. `then` follows the drain (the exit), or nothing (a natural end).
   */
  const armCeiling = (then?: () => void): void => {
    if (ceilingPassed) giveUpStalled();
    else if (ceiling === undefined) {
      ceiling = setTimeout(() => { ceilingPassed = true; giveUpStalled(); }, CONSOLE_EXIT_CEILING_MS);
      ceiling.unref?.();
    }
    void c.drained().then(() => { then?.(); });
  };
  return {
    cliConsole: c,
    /** A line to stderr: what the CLI says. */
    say,
    /** A line to stdout: the summary of a run that did not stop. */
    out: (s: string): void => { c.write('stdout', `${s}\n`); },
    /**
     * Wires the console for the CLI: the notice when a stream is given up (on the other stream, when that is a different, writable file),
     * the O_NONBLOCK precondition (touched, then read back; a pipe still blocking is said), fd 1 / 2's flags for the exit, and the
     * process's other writers routed through it. `where()` is the run's --report (or null); `restoreFlags`: saved at the very start.
     */
    prepareConsole(where: () => ReportView | null, restoreFlags?: () => void): { blocking: number[] } {
      report = where;
      c.shared = sys.sameFile();
      c.onGiveUp = (stream, why, reason) => {
        const other = OTHER[stream];
        if (c.gone[other] || c.shared) return; // one file: the notice would go into the very pipe that was given up
        const ceilingHit = reason === 'ceiling'; // R36-6: the reason passed in, never parsed back from the words
        const stalled = reason !== 'error';
        const dropped = 'the rest of what it was given (the stop message or the summary among it) was dropped';
        const what = ceilingHit ? `: ${why}: ${dropped}` : stalled ? ` had ${why}: ${dropped}` : ` is closed (${why}): what it was given is not printed there`;
        const line = `${stream}${what}; ${hint(stalled)}\n`;
        if (ceilingHit && oneNotice) return; // the other is given up too: said once for both (giveUpStalled)
        if (ceilingHit) sys.writeNow(FD[other], line); // the exit is due: one try, before the other is looked at
        else c.write(other, line);
      };
      restore.push(restoreFlags ?? sys.saveFlags());
      void process.stdout; // bun makes fd 1 / 2 O_NONBLOCK when the stream is first touched
      void process.stderr;
      restore.push(sys.capture(c)); // the logger's lines join the same queues
      sys.onExit(() => { sayFinalWord(); putBack(); }); // a run that ends by itself (exit 0 / 1 / 3): its final word, then put back (B29-2, B33-2)
      const blocking = sys.blockingFds();
      if (blocking.length > 0) say(`the console (fd ${blocking.join(', ')}) is in blocking mode: a reader that stops reading holds the run up until it reads again`);
      return { blocking };
    },
    /**
     * Exits with `code` once the console is drained or given up, at most CONSOLE_EXIT_CEILING_MS later (R29-4). Asked once (R29-2): a
     * later ask (main's catch, the pool's timeout, a stray error) keeps the first code and waits the same wait, never cutting the output.
     * No code: process.exitCode stands.
     */
    exitAfterConsole(code: number | undefined): Promise<void> {
      if (exiting !== null) return exiting.done;
      if (c.idle()) { exiting = { code, done: Promise.resolve() }; leave(code); return exiting.done; } // all written: at once
      const done = new Promise<void>((resolve) => { armCeiling(() => { leave(code); resolve(); }); });
      exiting = { code, done };
      return done;
    },
    /** A run that ends by itself (exit 0 / 1 / 3, R30-3): the same total ceiling, from now, on what it still has to say; no exit is forced. */
    endConsole(): void { if (exiting === null && !c.idle()) armCeiling(); },
    /**
     * A second signal (only): exits at once with the code already decided (`code` when none is yet). What is still queued is cut, and that
     * is said on the other stream when it is a different file that takes the line now (B29-4).
     */
    exitNow(code?: number): void {
      for (const stream of ['stdout', 'stderr'] as const) {
        const cut = c.queuedBytes(stream);
        const other = OTHER[stream];
        if (cut > 0 && !c.shared && !c.gone[other] && c.queuedBytes(other) === 0) {
          sys.writeNow(FD[other], `${stream}: ${cut} bytes of what it was given were not written: a second signal ended the run at once; ${hint(true)}\n`);
        }
      }
      leave(exiting !== null ? exiting.code : code); // no code: process.exitCode stands
    },
    /** An exit is decided and waits for the console. */
    exitPending: (): boolean => exiting !== null,
  };
}

/** The process's one console. */
export const { cliConsole, say, out, prepareConsole, exitAfterConsole, endConsole, exitNow, exitPending } = consoleApi(new Console());
