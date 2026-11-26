/**
 * The CLI's console (R27-2 / B27-1): every line the CLI says (notices, the stop message, the summary, the closing line) is written
 * synchronously, with fs.writeSync to fd 1 or 2, so a `process.exit` right after it cannot drop it. bun's process.stderr.write keeps what
 * a pipe (64 KiB) did not take in its own buffer, and process.exit drops that buffer: a reader that lags (`| less` not yet scrolled, a
 * log shipper that stalls, ssh over a slow link) got a stop message cut mid-line.
 *
 * bun leaves the fd O_NONBLOCK, so a full pipe answers EAGAIN: the write waits a little and retries, at most CONSOLE_WAIT_MS in all for
 * the process; past that the stream is given up (said nowhere: there is nowhere to say it) and the exit code is unchanged. A reader that
 * went away (EPIPE, or any other write error) gives the stream up at once, and never ends the run (round 18, B18-2).
 */
import { writeSync } from 'node:fs';

/** The longest the console may hold the process up, in all, waiting for a reader that does not read. */
export const CONSOLE_WAIT_MS = 30_000;
/** One wait between two tries on EAGAIN. */
const PAUSE_MS = 5;

export type Stream = 'stdout' | 'stderr';
const FD: Record<Stream, number> = { stdout: 1, stderr: 2 };

/** What the console needs from the system: replaced in tests only. */
export interface ConsoleDeps {
  write: (fd: number, buf: Buffer, offset: number, length: number) => number;
  pause: (ms: number) => void;
}
const block = new Int32Array(new SharedArrayBuffer(4));
const realDeps: ConsoleDeps = {
  write: (fd, buf, offset, length) => writeSync(fd, buf, offset, length),
  pause: (ms) => { Atomics.wait(block, 0, 0, ms); },
};

/** How a write ended: all of it written, not tried (the stream was given up before), or the stream given up now (why). */
export type WriteOutcome = 'written' | 'skipped' | { gone: string };

export class Console {
  readonly gone: Record<Stream, boolean> = { stdout: false, stderr: false };
  private waited = 0;
  constructor(private readonly deps: ConsoleDeps = realDeps) {}

  /** Writes all of `text` to the stream, or gives the stream up (then it is never written again: 'skipped'). */
  write(stream: Stream, text: string): WriteOutcome {
    if (this.gone[stream]) return 'skipped';
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < buf.length) {
      try {
        off += this.deps.write(FD[stream], buf, off, buf.length - off);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN' && this.waited < CONSOLE_WAIT_MS) {
          this.deps.pause(PAUSE_MS);
          this.waited += PAUSE_MS;
          continue;
        }
        this.gone[stream] = true;
        return { gone: code === 'EAGAIN' ? `no reader within ${CONSOLE_WAIT_MS / 1000} s` : (code ?? (err instanceof Error ? err.message : String(err))) };
      }
    }
    return 'written';
  }

  /** A stream written another way (the logger, through process.stdout) failed: it is not written here either. */
  markGone(stream: Stream): void { this.gone[stream] = true; }
}

/** The process's one console. */
export const cliConsole = new Console();
/** A line to stderr: what the CLI says. */
export const say = (s: string): void => { cliConsole.write('stderr', `${s}\n`); };
