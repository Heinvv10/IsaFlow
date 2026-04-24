/**
 * Account lockout (PR-3 / M24).
 *
 * Hard-locks an `(email, ip)` pair after `MAX_FAILED_ATTEMPTS` consecutive
 * failed authentication attempts, for `LOCKOUT_DURATION_MS`. Complements the
 * existing per-email / per-IP rate limits in `rateLimit.ts` — the rate limiter
 * caps attempt rate; this caps total attempts before a hard stop.
 *
 * Keyed on `(email, ip)` to avoid lockout-amplification DoS: an attacker at
 * one IP can only lock themselves out, not the legitimate user at another IP.
 */

import { sql } from '@/lib/neon';

export interface LockoutStatus {
  locked: boolean;
  retryAfterSecs: number;
}

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;
// If the last failure is older than this, the attempt window has passed and
// we start the counter from zero again.
const COUNTER_DECAY_MS = 60 * 60 * 1000;

function normalise(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Returns `{ locked: true, retryAfterSecs }` if the `(email, ip)` pair is
 * currently locked. Does not touch the counter — pure read.
 */
export async function checkLockout(email: string, ip: string): Promise<LockoutStatus> {
  const rows = (await sql`
    SELECT locked_until
    FROM account_lockouts
    WHERE email = ${normalise(email)} AND ip = ${ip}
    LIMIT 1
  `) as Array<{ locked_until: Date | string | null }>;

  const row = rows[0];
  if (!row?.locked_until) return { locked: false, retryAfterSecs: 0 };

  const lockedUntil = row.locked_until instanceof Date
    ? row.locked_until.getTime()
    : new Date(row.locked_until).getTime();
  const remainingMs = lockedUntil - Date.now();
  if (remainingMs <= 0) return { locked: false, retryAfterSecs: 0 };

  return { locked: true, retryAfterSecs: Math.ceil(remainingMs / 1000) };
}

/**
 * Records a failed authentication attempt. If the attempt pushes the counter
 * past the threshold, sets `locked_until` and returns `{ locked: true }`.
 *
 * Stale counters (last failure older than `COUNTER_DECAY_MS`) reset to 1
 * rather than incrementing — this prevents a trickle of failures over days
 * from eventually tripping the lockout.
 */
export async function recordFailure(email: string, ip: string): Promise<LockoutStatus> {
  const normEmail = normalise(email);
  const decayCutoff = new Date(Date.now() - COUNTER_DECAY_MS);
  const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);

  const rows = (await sql`
    INSERT INTO account_lockouts (email, ip, failed_count, last_failed_at)
    VALUES (${normEmail}, ${ip}, 1, NOW())
    ON CONFLICT (email, ip) DO UPDATE SET
      failed_count = CASE
        WHEN account_lockouts.last_failed_at < ${decayCutoff} THEN 1
        ELSE account_lockouts.failed_count + 1
      END,
      last_failed_at = NOW(),
      locked_until = CASE
        WHEN (CASE
          WHEN account_lockouts.last_failed_at < ${decayCutoff} THEN 1
          ELSE account_lockouts.failed_count + 1
        END) >= ${MAX_FAILED_ATTEMPTS} THEN ${lockedUntil}
        ELSE account_lockouts.locked_until
      END
    RETURNING failed_count, locked_until
  `) as Array<{ failed_count: number; locked_until: Date | string | null }>;

  const row = rows[0];
  if (!row?.locked_until) return { locked: false, retryAfterSecs: 0 };

  const lockedUntilMs = row.locked_until instanceof Date
    ? row.locked_until.getTime()
    : new Date(row.locked_until).getTime();
  const remainingMs = lockedUntilMs - Date.now();
  if (remainingMs <= 0) return { locked: false, retryAfterSecs: 0 };

  return { locked: true, retryAfterSecs: Math.ceil(remainingMs / 1000) };
}

/**
 * Clears the lockout row for `(email, ip)` on successful authentication.
 * No-op if no row exists.
 */
export async function clearLockout(email: string, ip: string): Promise<void> {
  await sql`
    DELETE FROM account_lockouts
    WHERE email = ${normalise(email)} AND ip = ${ip}
  `;
}
