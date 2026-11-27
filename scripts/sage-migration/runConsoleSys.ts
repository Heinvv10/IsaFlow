/**
 * What the CLI's console (runConsole.ts) needs from the process and the system, apart from the writer itself:
 *   - whether fd 1 and fd 2 are one open file (2>&1), and which of them is a pipe or socket still in blocking mode;
 *   - their O_NONBLOCK flags as found at start, put back when the CLI exits or ends by itself (B29-2): the flag belongs to the open file
 *     description, so a wrapper's later writers on the same pipe would otherwise meet EAGAIN. Through fcntl (bun:ffi, Linux libc);
 *     elsewhere, or when it cannot be loaded, nothing is changed and nothing is claimed. O_NONBLOCK is set again before every write to a
 *     pipe, the console's (B30-1) and the exit's one tries (writeNow, B31-1), and only a flag still as the CLI set it is put back;
 *   - routing the process's other writers (the logger: process.stdout.write / process.stderr.write) through the console (R28-7, R29-3,
 *     R29-8): node's write contract kept (encoding, Buffers as they are, a null chunk refused as node does, the callback only once that
 *     chunk is written or its stream given up, `false` and then 'drain' while it waits), and restored at exit.
 * Named limits:
 *   - (R29-7, B29-5) bun leaves a terminal in blocking mode, so on a tty a paused terminal (Ctrl-S, a stalled ssh) holds the run until it
 *     reads again; nothing is said of it on every run. Give --report and redirect, or run it under tmux.
 *   - (B30-1, B30-3, B30-4) the flags cannot be put back for others: two CLIs (or any two programs) sharing one pipe change one flag
 *     between them, so the pipe may be left non-blocking after both; a CLI killed by SIGKILL or by a signal it does not handle (only INT,
 *     TERM and HUP are) never puts them back; a foreign 'exit' listener that runs before the CLI's and throws skips it. Give each run its
 *     own pipe, or --report.
 */
import { fstatSync, readFileSync, writeSync } from 'node:fs';
import { isatty } from 'node:tty';
import type { Console, Stream } from './runConsoleQueue';

const O_NONBLOCK = 0o4000;

/** An error's message, never throwing (B34-2, B35-2, R35-3): a hostile toString, a message getter that throws, a message that is a hostile object. */
export const told = (err: unknown): string => {
  try { return String(err instanceof Error ? err.message : err); } catch { return 'an error whose message cannot be read'; }
};

/** Whether fd 1 and fd 2 are one open file (2>&1): a stream given up cannot be said on the other then. */
export function sameFile(): boolean {
  try {
    const [a, b] = [fstatSync(1), fstatSync(2)];
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return true; // cannot tell: never write a notice into what may be the stalled pipe itself
  }
}

/** The fd's file status flags (Linux: /proc/self/fdinfo); null when not known. */
export function fdFlags(fd: number): number | null {
  try {
    const flags = /flags:\s*([0-7]+)/.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1];
    return flags === undefined ? null : Number.parseInt(flags, 8);
  } catch {
    return null;
  }
}

/** fd 1 / fd 2 when it is a pipe or socket still in blocking mode. A terminal is the named limit above, never said. */
export function blockingFds(): number[] {
  return [1, 2].filter((fd) => {
    try {
      const st = fstatSync(fd);
      if (isatty(fd) || (!st.isFIFO() && !st.isSocket())) return false; // a file, /dev/null or a tty: nothing to say
      const flags = fdFlags(fd);
      return flags !== null && (flags & O_NONBLOCK) === 0;
    } catch {
      return false; // not known: nothing is claimed
    }
  });
}

type Fcntl = (fd: number, cmd: number, arg: number) => number;
let fcntl: Fcntl | null | undefined;
/** libc's fcntl through bun:ffi; null under node or when it cannot be loaded. */
function loadFcntl(): Fcntl | null {
  if (fcntl !== undefined) return fcntl;
  fcntl = null;
  if ((process.versions as { bun?: string }).bun === undefined || process.platform !== 'linux') return fcntl;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- bun:ffi has no ESM default, and this runs only under bun
    const ffi = require('bun:ffi') as { dlopen: (lib: string, s: Record<string, unknown>) => { symbols: { fcntl: Fcntl } }; FFIType: Record<string, unknown> };
    fcntl = ffi.dlopen('libc.so.6', { fcntl: { args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 } }).symbols.fcntl;
  } catch {
    fcntl = null; // no libc to load: the flags are left as they are (and not claimed restored)
  }
  return fcntl;
}

/**
 * Remembers fd 1 / fd 2's O_NONBLOCK as found; returns what puts back the ones the CLI changed (B29-2). Only a flag that is still what the
 * CLI set (found blocking, now non-blocking) is put back (B30-1): one another process has changed since is left as it is.
 */
export function saveFlags(): () => void {
  const found = [1, 2].map((fd) => [fd, fdFlags(fd)] as const);
  return () => {
    const f = loadFcntl();
    if (f === null) return;
    for (const [fd, flags] of found) {
      if (flags === null || (flags & O_NONBLOCK) !== 0) continue; // it was non-blocking already: nothing of ours to undo
      const now = f(fd, 3 /* F_GETFL */, 0);
      if (now >= 0 && (now & O_NONBLOCK) !== 0) f(fd, 4 /* F_SETFL */, now & ~O_NONBLOCK);
    }
  };
}

const pipeLike = new Map<number, boolean>();
/**
 * Before each write to a pipe or socket (B30-1): O_NONBLOCK set again if it is not (one fcntl; a second, only when it was cleared). The
 * flag belongs to the pipe, so another process on it (a second CLI that exited and put it back) can clear it under this one; a write to
 * a blocking pipe whose reader stalls would hold the thread in write(2), past the console's budget and deaf to signals. A file, /dev/null
 * or a terminal is never changed (a tty stays blocking: the named limit above).
 */
export function keepNonBlocking(fd: number): void {
  let pipe = pipeLike.get(fd);
  if (pipe === undefined) {
    try { const st = fstatSync(fd); pipe = !isatty(fd) && (st.isFIFO() || st.isSocket()); } catch { pipe = false; }
    pipeLike.set(fd, pipe);
  }
  const f = pipe ? loadFcntl() : null;
  if (f === null) return;
  const now = f(fd, 3 /* F_GETFL */, 0);
  if (now >= 0 && (now & O_NONBLOCK) === 0) f(fd, 4 /* F_SETFL */, now | O_NONBLOCK);
}

/**
 * One try, no wait: false when the line was not taken (the other stream is gone too: nowhere to say it). Only on the way out (B29-4): a
 * second signal's cut notice, the ceiling's, a restore that failed. O_NONBLOCK is set again first (B31-1), as before every write: on a
 * pipe another program put back to blocking, the try would otherwise wait in write(2) for the reader, deaf to the next signal.
 */
export function writeNow(fd: number, text: string): boolean {
  try {
    keepNonBlocking(fd);
    return writeSync(fd, text) === Buffer.byteLength(text);
  } catch {
    return false;
  }
}

const streamError = (code: string, message: string): TypeError => Object.assign(new TypeError(message), { code });
/**
 * Routes process.stdout / process.stderr.write through the console, node's contract kept; returns what restores them (R29-8).
 */
export function captureProcessStreams(c: Console): () => void {
  const saved: Array<[NodeJS.WriteStream, NodeJS.WriteStream['write']]> = [];
  for (const stream of ['stdout', 'stderr'] as const satisfies readonly Stream[]) {
    const s = process[stream];
    saved.push([s, s.write]);
    s.write = ((chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
      if (chunk === null) throw streamError('ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw streamError('ERR_INVALID_ARG_TYPE', 'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array');
      const encoding = typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8';
      const done = (typeof enc === 'function' ? enc : cb) as ((err?: Error | null) => void) | undefined;
      const data = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      // As node: the callback never runs inside write itself, even when the chunk was all taken at once.
      return c.write(stream, data, done === undefined ? undefined : (err) => { process.nextTick(() => done(err ?? null)); });
    }) as NodeJS.WriteStream['write'];
  }
  c.onDrain = (stream) => { process[stream].emit('drain'); };
  return () => { for (const [s, write] of saved) s.write = write; c.onDrain = null; };
}
