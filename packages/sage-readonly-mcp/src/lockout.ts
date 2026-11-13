/**
 * Failed-login guard. Sage locks the user after 20 failed logins in an hour; this server stops
 * itself far short of that, and it FAILS CLOSED.
 *
 * Every 401/403 appends one line (the time in ms) to auth-failures.log. An O_APPEND write of a short
 * line is atomic, so concurrent server processes never lose or truncate each other's entries, and a
 * restart does not reset the count. Once MAX_FAILURES fall inside the rolling hour, no request is
 * sent at all until the oldest one ages out.
 *
 * Fail-closed cases (no request is sent, the message says how to recover):
 *   - the ledger cannot be read or holds a line that is not a timestamp (corrupt or tampered);
 *   - a failure could not be written down (state dir not writable, disk full): this process also
 *     keeps its own in-memory count, and refuses everything after an unrecorded failure.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_FAILURES = 3;
export const WINDOW_MS = 60 * 60 * 1000;

export class SageLockoutGuardError extends Error {
  override name = 'SageLockoutGuardError';
}

export class LoginFailureLedger {
  readonly file: string;
  /** Failures this process could NOT write to disk; they still count. */
  private readonly memory: number[] = [];
  private unrecorded = false;

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = join(stateDir, 'auth-failures.log');
  }

  /** The timestamps on disk; throws (fail closed) on anything that is not a clean ledger. */
  private readDisk(): number[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new SageLockoutGuardError(`Stopped: the failed-login ledger ${this.file} cannot be read. Fix its permissions; no Sage request is sent until then.`);
    }
    const out: number[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const t = Number(line.trim());
      if (!/^\d{1,16}$/.test(line.trim()) || !Number.isFinite(t)) {
        throw new SageLockoutGuardError(
          `Stopped: the failed-login ledger ${this.file} is corrupt. Check the Sage login is not locked, then delete the file; no Sage request is sent until then.`,
        );
      }
      out.push(t);
    }
    return out;
  }

  private recent(): number[] {
    const cutoff = this.now() - WINDOW_MS;
    return [...this.readDisk(), ...this.memory].filter((t) => t > cutoff);
  }

  /** Throws when the next request could take Sage closer to its lockout. */
  assertMayAttempt(): void {
    if (this.unrecorded) {
      throw new SageLockoutGuardError(
        `Stopped: a failed Sage login could not be written to ${this.file}. Restart the server once the state directory is writable.`,
      );
    }
    const recent = this.recent();
    if (recent.length >= MAX_FAILURES) {
      const retryAt = new Date(Math.min(...recent) + WINDOW_MS).toISOString();
      throw new SageLockoutGuardError(
        `Stopped: ${recent.length} failed Sage logins in the last hour. Sage locks the user at 20, so `
        + `no request is sent until ${retryAt}. Fix the credentials in the env file first.`,
      );
    }
  }

  recordFailure(): void {
    const t = this.now();
    try {
      mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, `${t}\n`, { mode: 0o600, flag: 'a' });
    } catch {
      // Not swallowed: the flag makes every later attempt refuse (fail closed), and the
      // in-memory entry still counts toward the limit.
      this.memory.push(t);
      this.unrecorded = true;
    }
  }

  failuresInWindow(): number {
    try {
      return this.recent().length;
    } catch {
      // The ledger became unreadable; the in-memory count is the best this process knows.
      return this.memory.filter((t) => t > this.now() - WINDOW_MS).length;
    }
  }
}
