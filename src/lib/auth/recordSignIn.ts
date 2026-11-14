/**
 * Stamps users.last_login and bumps users.login_count when a sign-in issues a session.
 *
 * Until audit 2026-11-14 (item 1.1) nothing wrote last_login, so the admin console's active-user figures, Last
 * Login, Login Count and churn signals were permanently empty. GoTrue owns the session, so the stamp is taken at
 * the places this app turns a verified identity into cookies, and only there:
 *   - pages/api/auth/login.ts              password login with no 2FA factor
 *   - pages/api/auth/2fa-challenge.ts      a passed 2FA code
 *   - src/lib/auth/inviteAcceptSession.ts  invitation accept (POST /api/invitations/[token]/accept)
 * Not a sign-in, so not hooked: token refresh, change-password, and admin impersonation (the admin's session).
 *
 * Runs on the migration_admin login, in a pool of its own (signInStampPool.ts) so it never takes a connection a
 * route has just released (fixed, parameterised statement keyed on the verified user id): no app role may
 * write users columns an attacker could forge under a stolen claim (S-07, migration 902). Migration 990 grants
 * migration_admin UPDATE on exactly these two columns and refuses to apply without it.
 *
 * Callers do not await it (`void recordSignInSafely(...)`): a sign-in never waits on the stamp. The stamp runs in
 * a transaction whose statement_timeout cancels abandoned work, and it never waits on a row lock
 * (FOR NO KEY UPDATE SKIP LOCKED): a row an admin is suspending is skipped and the sign-in goes uncounted. It is
 * NO KEY UPDATE, not UPDATE, so a request in flight (its FK inserts hold FOR KEY SHARE on the users row) does not
 * make the stamp skip.
 */
import { signInStampPool } from '@/lib/auth/signInStampPool';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { log } from '@/lib/logger';

/** A second sign-in inside this window is the same visit (double submit, 2FA retry): stamped once. */
export const SIGN_IN_THROTTLE_MINUTES = 5;
/** The stamp's own bound, so a stuck table lock or slow database cancels it instead of holding a pool slot. */
export const SIGN_IN_STAMP_TIMEOUT_MS = 2000;

interface StampClient { query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }> }

/**
 * The stamp itself, on a client the caller has put in a transaction (and, in a test, under SET ROLE migration_admin).
 * True when a row was stamped; false when throttled, locked, or the user has no profile row yet.
 * The statement text is a literal at the query call so the rollback census (tests/unit/lib/rollbackCensus.test.ts) reads it.
 */
export async function stampSignIn(client: StampClient, userId: string): Promise<boolean> {
  const result = await client.query(
    `WITH due AS (
       SELECT id FROM users
        WHERE id = $1
          AND (last_login IS NULL OR last_login < NOW() - make_interval(mins => $2::int))
        FOR NO KEY UPDATE SKIP LOCKED
     )
     UPDATE users u
        SET last_login = NOW(), login_count = u.login_count + 1
       FROM due
      WHERE u.id = due.id`,
    [userId, SIGN_IN_THROTTLE_MINUTES],
  );
  return result.rowCount === 1;
}

/** True when a row was stamped (see stampSignIn). Throws on a database error; the stamp is rolled back. */
export async function recordSignIn(userId: string): Promise<boolean> {
  const client = await signInStampPool().connect();
  let broken = false;
  let opened = false;
  try {
    opened = true; // before BEGIN (R-176): a BEGIN that reached the server but failed is rolled back too
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 2000'); // SIGN_IN_STAMP_TIMEOUT_MS, pinned equal by a unit test
    const stamped = await stampSignIn(client, userId);
    await client.query('COMMIT');
    opened = false;
    return stamped;
  } catch (err) {
    if (opened) broken = await rollbackFailed(client, 'recordSignIn');
    throw err;
  } finally {
    client.release(broken);
  }
}

/** recordSignIn that never throws: a failure is logged and swallowed. Call it with `void`, not `await`. */
export async function recordSignInSafely(userId: string, via: string): Promise<void> {
  try {
    await recordSignIn(userId);
  } catch (err) {
    log.warn('sign-in not recorded', { userId, via, message: err instanceof Error ? err.message : String(err) }, 'Auth');
  }
}
