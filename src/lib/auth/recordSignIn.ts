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
 * Runs on the migration_admin pool (fixed, parameterised statement keyed on the verified user id): no app role may
 * write users columns an attacker could forge under a stolen claim (S-07, migration 902). Migration 990 grants
 * migration_admin UPDATE on exactly these two columns and refuses to apply without it.
 *
 * Callers do not await it (`void recordSignInSafely(...)`): a sign-in never waits on the stamp. The stamp runs in
 * a transaction whose statement_timeout cancels abandoned work, and it never waits on a row lock
 * (FOR NO KEY UPDATE SKIP LOCKED): a row an admin is suspending is skipped and the sign-in goes uncounted. It is
 * NO KEY UPDATE, not UPDATE, so a request in flight (its FK inserts hold FOR KEY SHARE on the users row) does not
 * make the stamp skip.
 */
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { log } from '@/lib/logger';

/** A second sign-in inside this window is the same visit (double submit, 2FA retry): stamped once. */
export const SIGN_IN_THROTTLE_MINUTES = 5;
/** The stamp's own bound, so a stuck table lock or slow database cancels it instead of holding a pool slot. */
export const SIGN_IN_STAMP_TIMEOUT_MS = 2000;

/** Parameters: $1 user id, $2 throttle minutes. Exported so a test can run it as migration_admin in a transaction. */
export const SIGN_IN_STAMP_SQL = `WITH due AS (
       SELECT id FROM users
        WHERE id = $1
          AND (last_login IS NULL OR last_login < NOW() - make_interval(mins => $2::int))
        FOR NO KEY UPDATE SKIP LOCKED
     )
     UPDATE users u
        SET last_login = NOW(), login_count = u.login_count + 1
       FROM due
      WHERE u.id = due.id`;

/** True when a row was stamped; false when throttled, locked, or the user has no profile row yet. */
export async function recordSignIn(userId: string): Promise<boolean> {
  const client = await migrationAdminPool().connect();
  let broken = false;
  let opened = false;
  try {
    opened = true; // before BEGIN (R-176): a BEGIN that reached the server but failed is rolled back too
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${SIGN_IN_STAMP_TIMEOUT_MS}`);
    const result = await client.query(SIGN_IN_STAMP_SQL, [userId, SIGN_IN_THROTTLE_MINUTES]);
    await client.query('COMMIT');
    opened = false;
    return result.rowCount === 1;
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
