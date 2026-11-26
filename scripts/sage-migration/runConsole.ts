/**
 * The CLI's console (R27-2, R28-1, R28-6, R28-7, B28-1). bun's process.stderr.write keeps what a pipe did not take in its own buffer, and
 * process.exit drops it: a reader that lagged got a stop message cut mid-line. So every line the CLI says goes through this console:
 *   - written with fs.writeSync to fd 1 or 2, at once while the pipe takes it;
 *   - what a full pipe does not take (EAGAIN) is queued per stream and retried on a timer, so the event loop keeps running (timers, the
 *     run lock's keepalive, a second signal) while a reader lags;
 *   - each stream has its own budget, CONSOLE_WAIT_MS of NO PROGRESS (a Date.now deadline, reset by every byte written): a stalled stdout
 *     never costs stderr its time;
 *   - a stream with no progress for that long, or that fails (EPIPE, ENOSPC), is given up: the rest of its output is dropped, and that is
 *     said on the other stream when it is a different, writable file (`onGiveUp`); the exit code is never changed by it;
 *   - the CLI exits only once both streams are drained or given up (`exitAfterConsole`); a second request to end (a second signal) while
 *     it waits ends the process at once, with the same exit code.
 * Precondition (R28-6): fd 1 and 2 must be O_NONBLOCK, or a write to a pipe nobody reads blocks for ever. bun sets that once
 * process.stdout / process.stderr are first touched: `prepareConsole` touches both at the CLI's start and reads the flags back
 * (/proc/self/fdinfo); one still blocking is said. A pipe holds little (8 KiB on velo): a large run should give --report.
 */
import { fstatSync, readFileSync, writeSync } from 'node:fs';

/** How long a stream may make no progress before it is given up. */
export const CONSOLE_WAIT_MS = 30_000;
/** One wait between two tries on EAGAIN. */
const PAUSE_MS = 5;

export type Stream = 'stdout' | 'stderr';
const FD: Record<Stream, number> = { stdout: 1, stderr: 2 };
const OTHER: Record<Stream, Stream> = { stdout: 'stderr', stderr: 'stdout' };

/** What the console needs from the system: replaced in tests only. */
export interface ConsoleDeps {
  write: (fd: number, buf: Buffer, offset: number, length: number) => number;
  now: () => number;
  later: (fn: () => void, ms: number) => void;
}
const realDeps: ConsoleDeps = {
  write: (fd, buf, offset, length) => writeSync(fd, buf, offset, length),
  now: () => Date.now(),
  later: (fn, ms) => { setTimeout(fn, ms); }, // ref'd: queued output keeps the process alive until written or given up
};

type Lane = 'stdout' | 'stderr' | 'shared';
interface Pending { stream: Stream; buf: Buffer }

export class Console {
  readonly gone: Record<Stream, boolean> = { stdout: false, stderr: false };
  /** Said when a stream is given up: `why` is the error code, or "no reader within N s". */
  onGiveUp: ((stream: Stream, why: string) => void) | null = null;
  /**
   * fd 1 and fd 2 are one open file (2>&1): one queue, in the order said, so two streams never interleave inside a line, and one budget
   * (the pipe's progress is both streams' progress). Otherwise a queue and a budget each.
   */
  shared = false;
  private readonly lanes: Record<Lane, { q: Pending[]; lastProgress: number; retrying: boolean }> = {
    stdout: { q: [], lastProgress: 0, retrying: false }, stderr: { q: [], lastProgress: 0, retrying: false }, shared: { q: [], lastProgress: 0, retrying: false },
  };
  private waiters: Array<() => void> = [];
  constructor(private readonly deps: ConsoleDeps = realDeps) {}

  /** Writes `text` to the stream now, as far as it is taken; the rest is queued. A stream given up is not written. */
  write(stream: Stream, text: string): void {
    if (this.gone[stream]) return;
    const lane = this.shared ? 'shared' : stream;
    const l = this.lanes[lane];
    l.q.push({ stream, buf: Buffer.from(text, 'utf8') });
    if (l.q.length === 1 && !l.retrying) {
      l.lastProgress = this.deps.now();
      this.pump(lane);
    }
  }

  /** Resolves once both streams are written out or given up. */
  drained(): Promise<void> {
    if (this.idle()) return Promise.resolve();
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  /** A stream written another way (the logger, through process.stdout) failed (`why`): it is not written here either. */
  markGone(stream: Stream, why: string): void { this.giveUp([stream], why); }

  /** Nothing is waiting to be written. */
  idle(): boolean { return Object.values(this.lanes).every((l) => l.q.length === 0); }

  private pump(lane: Lane): void {
    const l = this.lanes[lane];
    while (l.q.length > 0) {
      const head = l.q[0]!;
      let n: number;
      try {
        n = this.deps.write(FD[head.stream], head.buf, 0, head.buf.length);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EAGAIN') { this.giveUp([head.stream], code ?? (err instanceof Error ? err.message : String(err))); continue; }
        n = 0;
      }
      if (n > 0) l.lastProgress = this.deps.now(); // any byte taken starts the budget over (R28-1)
      if (n >= head.buf.length) { l.q.shift(); continue; }
      if (n > 0) { head.buf = head.buf.subarray(n); continue; }
      if (this.deps.now() - l.lastProgress >= CONSOLE_WAIT_MS) {
        this.giveUp(lane === 'shared' ? ['stdout', 'stderr'] : [lane], `no reader within ${CONSOLE_WAIT_MS / 1000} s`);
        continue;
      }
      l.retrying = true;
      this.deps.later(() => { l.retrying = false; this.pump(lane); }, PAUSE_MS);
      return;
    }
    this.settle();
  }

  private giveUp(streams: Stream[], why: string): void {
    for (const stream of streams) {
      const wasGone = this.gone[stream];
      this.gone[stream] = true;
      for (const l of Object.values(this.lanes)) l.q = l.q.filter((p) => p.stream !== stream);
      if (!wasGone) this.onGiveUp?.(stream, why); // said once (B19-3)
    }
    this.settle();
  }

  private settle(): void {
    if (!this.idle()) return;
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }
}

/** Whether fd 1 and fd 2 are one open file (2>&1): a stream given up cannot be said on the other then. */
function sameFile(): boolean {
  try {
    const [a, b] = [fstatSync(1), fstatSync(2)];
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return true; // cannot tell: never write a notice into what may be the stalled pipe itself
  }
}
/** fd 1 / fd 2 when it is a pipe, socket or terminal still in blocking mode (Linux: /proc/self/fdinfo; elsewhere not known). */
function blockingFds(): number[] {
  return [1, 2].filter((fd) => {
    try {
      const st = fstatSync(fd);
      if (!st.isFIFO() && !st.isSocket() && !st.isCharacterDevice()) return false; // a file or /dev/null never makes a writer wait
      const flags = /flags:\s*([0-7]+)/.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1];
      return flags !== undefined && (Number.parseInt(flags, 8) & 0o4000) === 0;
    } catch {
      return false; // not known: nothing is claimed
    }
  });
}

/** The console's CLI side, for one Console (the process's own; a test's). `sameFile` / `blockingFds` are replaced in tests only. */
export function consoleApi(c: Console, sys: { sameFile: () => boolean; blockingFds: () => number[] } = { sameFile, blockingFds }) {
  const say = (s: string): void => { c.write('stderr', `${s}\n`); };
  let exiting: number | null = null;
  return {
    cliConsole: c,
    /** A line to stderr: what the CLI says. */
    say,
    /** A line to stdout: the summary of a run that did not stop. */
    out: (s: string): void => { c.write('stdout', `${s}\n`); },
    /**
     * Wires the console for the CLI: the notice when a stream is given up (on the other stream, when that is a different, writable file),
     * and the O_NONBLOCK precondition (touched, then read back; one still blocking is said). `report()` names --report, or null.
     */
    prepareConsole(report: () => string | null): { blocking: number[] } {
      c.shared = sys.sameFile();
      c.onGiveUp = (stream, why) => {
        const other = OTHER[stream];
        if (c.gone[other] || c.shared) return; // one file: the notice would go into the very pipe that was given up
        const where = report();
        const hint = where === null ? 'give --report <path>: a pipe holds only a few KiB, and a large run says more' : `--report ${where} holds the run's report`;
        const what = /^no reader/.test(why) ? `had ${why}: the rest of what it was given (the stop message or the summary among it) was dropped` : `is closed (${why}): what it was given is not printed there`;
        c.write(other, `${stream} ${what}; ${hint}\n`);
      };
      void process.stdout; // bun makes fd 1 / 2 O_NONBLOCK when the stream is first touched
      void process.stderr;
      const blocking = sys.blockingFds();
      if (blocking.length > 0) say(`the console (fd ${blocking.join(', ')}) is in blocking mode: a reader that stops reading holds the run up until it reads again`);
      return { blocking };
    },
    /**
     * Exits with `code` once the console is drained or given up (never while a write is pending). A second end asked for while it waits
     * (a second signal, B28-1) exits at once, with the code already decided.
     */
    exitAfterConsole(code: number | undefined): Promise<void> {
      if (exiting !== null) { process.exit(exiting); return Promise.resolve(); }
      exiting = code ?? process.exitCode ?? 0;
      const exit = () => (code === undefined ? process.exit() : process.exit(code)); // no code: process.exitCode stands
      if (c.idle()) { exit(); return Promise.resolve(); } // all written: at once
      return c.drained().then(exit);
    },
    /** An exit is already decided and waits for the console: a further end must not say or write anything more. */
    exitPending: (): boolean => exiting !== null,
  };
}

/** The process's one console. */
export const { cliConsole, say, out, prepareConsole, exitAfterConsole, exitPending } = consoleApi(new Console());
