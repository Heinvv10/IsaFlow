/**
 * The console's queues (split from runConsole.ts, which wires them for the CLI): every line written with fs.writeSync to fd 1 or 2, what a
 * full pipe does not take (EAGAIN) queued per stream (one lane when fd 1 and 2 are one file) and retried on a timer, each lane with its
 * own budget of no progress; a stream that makes none for that long, or fails, is given up (R27-2, R28-1, R28-6, B28-1, R29-3, B30-1).
 */
import { writeSync } from 'node:fs';
import { codeOf, keepNonBlocking, told } from './runConsoleSys';

/** How long a stream may make no progress before it is given up. */
export const CONSOLE_WAIT_MS = 30_000;
/** One wait between two tries on EAGAIN. */
const PAUSE_MS = 5;

export type Stream = 'stdout' | 'stderr';
/** Why a stream was given up (R36-6: one source, passed in, never parsed back from the words): it failed, it made no progress, or the exit's ceiling. */
export type GoneReason = 'error' | 'stall' | 'ceiling';
export const FD: Record<Stream, number> = { stdout: 1, stderr: 2 };

/** What the console needs from the system: replaced in tests only. */
export interface ConsoleDeps {
  write: (fd: number, buf: Buffer, offset: number, length: number) => number;
  now: () => number;
  later: (fn: () => void, ms: number) => void;
}
const realDeps: ConsoleDeps = {
  write: (fd, buf, offset, length) => { keepNonBlocking(fd); return writeSync(fd, buf, offset, length); }, // B30-1
  now: () => Date.now(),
  later: (fn, ms) => { setTimeout(fn, ms); }, // ref'd: queued output keeps the process alive until written or given up
};

type Lane = 'stdout' | 'stderr' | 'shared';
/** A chunk waiting to be written; `done` is called once its last byte is taken, or with an Error when its stream is given up. */
interface Pending { stream: Stream; buf: Buffer; done?: (err?: Error) => void }

export class Console {
  readonly gone: Record<Stream, boolean> = { stdout: false, stderr: false };
  /** Why each stream was FIRST given up (null while it is not): a stall or the ceiling leaves a pipe that may still take a short line (B35-1). */
  readonly goneFor: Record<Stream, GoneReason | null> = { stdout: null, stderr: null };
  /** Said when a stream is given up: `why` is the error code, "no reader within N s" or the ceiling's words; `reason` says which. */
  onGiveUp: ((stream: Stream, why: string, reason: GoneReason) => void) | null = null;
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

  /** A stream written another way failed (`why`), or (`stall`) the exit's ceiling gives it up: it is not written here either. */
  markGone(stream: Stream, why: string, reason: GoneReason = 'error'): void { this.giveUp([stream], why, reason); }

  /** Gives every stream up (the exit's ceiling): what is queued is dropped. */
  giveUpAll(why: string): void { this.giveUp(['stdout', 'stderr'], why, 'ceiling'); }

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
        const code = codeOf(err); // R36-3: a thrown null / undefined, or a value whose code cannot be read, is no EAGAIN
        if (code !== 'EAGAIN') { this.giveUp([head.stream], typeof code === 'string' ? code : told(err), 'error'); continue; }
        n = 0;
      }
      if (n > 0) l.lastProgress = this.deps.now(); // any byte taken starts the budget over (R28-1)
      if (n >= head.buf.length) { l.q.shift(); head.done?.(); continue; }
      if (n > 0) { head.buf = head.buf.subarray(n); continue; }
      if (this.deps.now() - l.lastProgress >= CONSOLE_WAIT_MS) {
        this.giveUp(lane === 'shared' ? ['stdout', 'stderr'] : [lane], `no reader within ${CONSOLE_WAIT_MS / 1000} s`, 'stall');
        continue;
      }
      l.retrying = true;
      this.deps.later(() => { l.retrying = false; this.pump(lane); }, PAUSE_MS);
      return;
    }
    this.settle();
  }

  private giveUp(streams: Stream[], why: string, reason: GoneReason): void {
    for (const stream of streams) {
      const wasGone = this.gone[stream];
      this.gone[stream] = true;
      if (!wasGone) this.goneFor[stream] = reason; // why it was FIRST given up
      for (const l of Object.values(this.lanes)) {
        for (const p of l.q) if (p.stream === stream) p.done?.(new Error(`${stream} was given up (${why})`));
        l.q = l.q.filter((p) => p.stream !== stream);
      }
      if (!wasGone) this.onGiveUp?.(stream, why, reason); // said once (B19-3)
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
