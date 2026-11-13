/**
 * Failed-login guard. Sage locks the user after 20 failed logins in an hour; this server stops
 * itself far short of that.
 *
 * Every 401/403 is recorded with its time in a small JSON file (so a restart does not reset the
 * count), and once MAX_FAILURES fall inside the rolling hour no request is sent at all until the
 * oldest one ages out. A wrong password therefore costs at most MAX_FAILURES of Sage's 20, even if
 * an agent retries in a loop or the server is restarted repeatedly.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_FAILURES = 3;
export const WINDOW_MS = 60 * 60 * 1000;

export class SageLockoutGuardError extends Error {}

export class LoginFailureLedger {
  private readonly file: string;

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = join(stateDir, 'auth-failures.json');
  }

  private read(): number[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((t): t is number => typeof t === 'number') : [];
    } catch {
      // A missing file is the normal first run. Corrupt JSON also starts a fresh ledger rather
      // than blocking forever; the next failure rewrites the file.
      return [];
    }
  }

  private recent(): number[] {
    const cutoff = this.now() - WINDOW_MS;
    return this.read().filter((t) => t > cutoff);
  }

  /** Throws when the next request could take Sage closer to its lockout. */
  assertMayAttempt(): void {
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
    const next = [...this.recent(), this.now()];
    mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(next), { mode: 0o600 });
  }

  failuresInWindow(): number {
    return this.recent().length;
  }
}
