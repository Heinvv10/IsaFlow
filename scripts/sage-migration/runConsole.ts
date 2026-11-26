/**
 * The CLI's console (R27-2, R28-1, R28-6, R28-7, B28-1, R29-2..4). bun's process.stderr.write keeps what a pipe did not take in its own
 * buffer, and process.exit drops it: a reader that lagged got a stop message cut mid-line. So every line the CLI says goes through this
 * console:
 *   - written with fs.writeSync to fd 1 or 2, at once while the pipe takes it;
 *   - what a full pipe does not take (EAGAIN) is queued per stream and retried on a timer, so the event loop keeps running (timers, the
 *     run lock's keepalive, a second signal) while a reader lags;
 *   - each stream has its own budget, CONSOLE_WAIT_MS of NO PROGRESS (a Date.now deadline, reset by every byte written): a stalled stdout
 *     never costs stderr its time; one shared queue and budget when fd 1 and fd 2 are one file (2>&1);
 *   - a stream with no progress for that long, or that fails (EPIPE, ENOSPC), is given up: the rest of its output is dropped, and that is
 *     said on the other stream when it is a different, writable file (`onGiveUp`); the exit code is never changed by it;
 *   - the CLI exits only once both streams are drained or given up (`exitAfterConsole`, asked once: a later ask keeps the first code and
 *     waits the same wait), and at most CONSOLE_EXIT_CEILING_MS after it was asked, whatever the progress (R29-4);
 *   - only a second SIGNAL ends it at once (`exitNow`): what is cut is said on the other stream when it can be (B29-4).
 * fd 1 / fd 2's O_NONBLOCK flags are put back as found, and process.*.write restored, at every exit (runConsoleSys.ts, B29-2, R29-8).
 * A pipe holds little (8-64 KiB on velo): a large run should give --report.
 */
import { writeSync } from 'node:fs';
import { blockingFds, captureProcessStreams, sameFile, saveFlags, writeNow } from './runConsoleSys';

export { blockingFds } from './runConsoleSys';

/** How long a stream may make no progress before it is given up. */
export const CONSOLE_WAIT_MS = 30_000;
/** The longest an exit waits for the console in all, progress or not (R29-4). */
export const CONSOLE_EXIT_CEILING_MS = 120_000;
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
/** A chunk waiting to be written; `done` is called once its last byte is taken, or with an Error when its stream is given up. */
interface Pending { stream: Stream; buf: Buffer; done?: (err?: Error) => void }

export class Console {
  readonly gone: Record<Stream, boolean> = { stdout: false, stderr: false };
  /** Said when a stream is given up: `why` is the error code, or "no reader within N s". */
  onGiveUp: ((stream: Stream, why: string) => void) | null = null;
  /** A stream whose write returned false has nothing queued any more ('drain' for process.*.write, R29-3). */
  onDrain: ((stream: Stream) => void) | null = null;
  /** fd 1 and fd 2 are one open file (2>&1): one queue, in the order said, and one budget. Otherwise a queue and a budget each. */
  shared = false;
  private readonly lanes: Record<Lane, { q: Pending[]; lastProgress: number; retrying: boolean }> = {
    stdout: { q: [], lastProgress: 0, retrying: false }, stderr: { q: [], lastProgress: 0, retrying: false }, shared: { q: [], lastProgress: 0, retrying: false },
  };
  private readonly owed: Record<Stream, boolean> = { stdout: false, stderr: false };
  private waiters: Array<() => void> = [];
  constructor(private readonly deps: ConsoleDeps = realDeps) {}

  /**
   * Writes `data` to the stream now, as far as it is taken; the rest is queued. Returns whether it was all written now (false: it waits,
   * and onDrain follows). A stream given up is not written (`done` gets an Error).
   */
  write(stream: Stream, data: string | Buffer, done?: (err?: Error) => void): boolean {
    if (this.gone[stream]) { done?.(new Error(`${stream} was given up`)); return true; }
    const lane = this.shared ? 'shared' : stream;
    const l = this.lanes[lane];
    l.q.push({ stream, buf: typeof data === 'string' ? Buffer.from(data, 'utf8') : data, done });
    if (l.q.length === 1 && !l.retrying) {
      l.lastProgress = this.deps.now();
      this.pump(lane);
    }
    if (this.queuedBytes(stream) === 0) return true;
    this.owed[stream] = true;
    return false;
  }

  /** Resolves once both streams are written out or given up. */
  drained(): Promise<void> {
    if (this.idle()) return Promise.resolve();
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  /** A stream written another way failed (`why`): it is not written here either. */
  markGone(stream: Stream, why: string): void { this.giveUp([stream], why); }

  /** Gives every stream up (the exit's ceiling): what is queued is dropped. */
  giveUpAll(why: string): void { this.giveUp(['stdout', 'stderr'], why); }

  /** Nothing is waiting to be written. */
  idle(): boolean { return Object.values(this.lanes).every((l) => l.q.length === 0); }

  /** Bytes of the stream still waiting. */
  queuedBytes(stream: Stream): number {
    return Object.values(this.lanes).reduce((n, l) => n + l.q.filter((p) => p.stream === stream).reduce((m, p) => m + p.buf.length, 0), 0);
  }

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
      if (n >= head.buf.length) { l.q.shift(); head.done?.(); continue; }
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
      for (const l of Object.values(this.lanes)) {
        for (const p of l.q) if (p.stream === stream) p.done?.(new Error(`${stream} was given up (${why})`));
        l.q = l.q.filter((p) => p.stream !== stream);
      }
      if (!wasGone) this.onGiveUp?.(stream, why); // said once (B19-3)
    }
    this.settle();
  }

  private settle(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.owed[stream] && this.queuedBytes(stream) === 0) { this.owed[stream] = false; this.onDrain?.(stream); }
    }
    if (!this.idle()) return;
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }
}

interface ConsoleSys {
  sameFile: () => boolean;
  blockingFds: () => number[];
  /** Routes the process's other writers through the console; returns what restores them. */
  capture: (c: Console) => () => void;
  /** Remembers fd 1 / 2's flags; returns what puts them back. */
  saveFlags: () => () => void;
  /** One try, no wait (the cut marker). */
  writeNow: (fd: number, text: string) => boolean;
  exit: (code?: number) => void;
}
const realSys: ConsoleSys = { sameFile, blockingFds, capture: captureProcessStreams, saveFlags, writeNow, exit: (code) => (code === undefined ? process.exit() : process.exit(code)) };

/** The console's CLI side, for one Console (the process's own; a test's). `sys` is replaced in tests only. */
export function consoleApi(c: Console, sys: ConsoleSys = realSys) {
  const say = (s: string): void => { c.write('stderr', `${s}\n`); };
  let exiting: { code: number | undefined; done: Promise<void> } | null = null;
  let report: () => string | null = () => null;
  let restore: Array<() => void> = [];
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const hint = (pipe: boolean): string => {
    const where = report();
    if (where !== null) return `--report ${where} holds the run's report`;
    return pipe ? 'give --report <path>: a pipe holds only a few KiB, and a large run says more' : 'give --report <path>: it always holds the whole report';
  };
  /** Puts the process back as found (flags, writers), then exits. */
  const leave = (code: number | undefined): void => {
    clearTimeout(ceiling);
    for (const r of restore.splice(0)) r();
    sys.exit(code);
  };
  return {
    cliConsole: c,
    /** A line to stderr: what the CLI says. */
    say,
    /** A line to stdout: the summary of a run that did not stop. */
    out: (s: string): void => { c.write('stdout', `${s}\n`); },
    /**
     * Wires the console for the CLI: the notice when a stream is given up (on the other stream, when that is a different, writable file),
     * the O_NONBLOCK precondition (touched, then read back; a pipe still blocking is said), fd 1 / 2's flags saved for the exit, and the
     * process's other writers routed through it. `where()` names --report, or null.
     */
    prepareConsole(where: () => string | null, restoreFlags?: () => void): { blocking: number[] } {
      report = where;
      c.shared = sys.sameFile();
      c.onGiveUp = (stream, why) => {
        const other = OTHER[stream];
        if (c.gone[other] || c.shared) return; // one file: the notice would go into the very pipe that was given up
        const stalled = /^no reader/.test(why);
        const what = stalled ? `had ${why}: the rest of what it was given (the stop message or the summary among it) was dropped` : `is closed (${why}): what it was given is not printed there`;
        c.write(other, `${stream} ${what}; ${hint(stalled)}\n`);
      };
      restore.push(restoreFlags ?? sys.saveFlags()); // as found: saved by the caller at its very start, or now
      void process.stdout; // bun makes fd 1 / 2 O_NONBLOCK when the stream is first touched
      void process.stderr;
      restore.push(sys.capture(c)); // the logger's lines join the same queues
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
      const done = new Promise<void>((resolve) => {
        ceiling = setTimeout(() => c.giveUpAll(`the exit waited ${CONSOLE_EXIT_CEILING_MS / 1000} s for its readers`), CONSOLE_EXIT_CEILING_MS);
        void c.drained().then(() => { leave(code); resolve(); });
      });
      exiting = { code, done };
      return done;
    },
    /**
     * A second signal (only): exits at once with the code already decided (or the one the run set). What is still queued is cut, and that
     * is said on the other stream when it is a different file that takes the line now (B29-4).
     */
    exitNow(): void {
      for (const stream of ['stdout', 'stderr'] as const) {
        const cut = c.queuedBytes(stream);
        const other = OTHER[stream];
        if (cut > 0 && !c.shared && !c.gone[other] && c.queuedBytes(other) === 0) {
          sys.writeNow(FD[other], `${stream}: ${cut} bytes of what it was given were not written: a second signal ended the run at once; ${hint(true)}\n`);
        }
      }
      leave(exiting !== null ? exiting.code : undefined); // no code: process.exitCode stands
    },
    /** An exit is decided and waits for the console. */
    exitPending: (): boolean => exiting !== null,
  };
}

/** The process's one console. */
export const { cliConsole, say, out, prepareConsole, exitAfterConsole, exitNow, exitPending } = consoleApi(new Console());
