/**
 * What the CLI's console (runConsole.ts) needs from the process and the system, apart from the writer itself:
 *   - whether fd 1 and fd 2 are one open file (2>&1), and which of them is a pipe or socket still in blocking mode;
 *   - their O_NONBLOCK flags as found at start, restored at every exit (B29-2): the flag belongs to the open file description, so a
 *     wrapper's later writers on the same pipe would otherwise meet EAGAIN. Restored through fcntl (bun:ffi, Linux libc); elsewhere, or
 *     when it cannot be loaded, nothing is changed and nothing is claimed;
 *   - routing the process's other writers (the logger: process.stdout.write / process.stderr.write) through the console (R28-7, R29-3,
 *     R29-8): node's write contract kept (encoding, Buffers as they are, a null chunk refused as node does, the callback only once that
 *     chunk is written or its stream given up, `false` and then 'drain' while it waits), and restored at exit.
 * Named limit (R29-7, B29-5): bun leaves a terminal in blocking mode, so on a tty a paused terminal (Ctrl-S, a stalled ssh) holds the
 * run until it reads again; nothing is said of it on every run. Give --report and redirect, or run it under tmux.
 */
import { fstatSync, readFileSync, writeSync } from 'node:fs';
import { isatty } from 'node:tty';
import type { Console, Stream } from './runConsole';

const O_NONBLOCK = 0o4000;

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

/** Remembers fd 1 / fd 2's O_NONBLOCK as found; returns what puts back the ones the CLI changed (B29-2). */
export function saveFlags(): () => void {
  const found = [1, 2].map((fd) => [fd, fdFlags(fd)] as const);
  return () => {
    const f = loadFcntl();
    if (f === null) return;
    for (const [fd, flags] of found) {
      if (flags === null) continue;
      const now = f(fd, 3 /* F_GETFL */, 0);
      if (now >= 0 && (now & O_NONBLOCK) !== (flags & O_NONBLOCK)) f(fd, 4 /* F_SETFL */, (now & ~O_NONBLOCK) | (flags & O_NONBLOCK));
    }
  };
}

/** One try, no wait: false when the line was not taken (the other stream is gone too: nowhere to say it). Only on the way out (B29-4). */
export function writeNow(fd: number, text: string): boolean {
  try {
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
      return c.write(stream, data, done === undefined ? undefined : (err) => done(err ?? null));
    }) as NodeJS.WriteStream['write'];
  }
  c.onDrain = (stream) => { process[stream].emit('drain'); };
  return () => { for (const [s, write] of saved) s.write = write; c.onDrain = null; };
}
