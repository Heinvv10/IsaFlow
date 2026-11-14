/**
 * Stamps users.last_login and bumps users.login_count when a sign-in issues a session.
 *
 * Until audit 2026-11-14 (item 1.1) nothing wrote last_login, so the admin console's active-user figures, Last
 * Login, Login Count and churn signals were permanently empty. GoTrue owns the session, so the stamp is taken at
 * the three places this app turns a verified identity into cookies: password login without 2FA, the 2FA
 * challenge, and invitation accept. Token refresh is not a sign-in and does not call this.
 *
 * Runs on the migration_admin pool (fixed, parameterised statement keyed on the verified user id): no app role may
 * write users columns an attacker could forge under a stolen claim (S-07, migration 902; the pool grants live in
 * migrationAdminPool.ts). The statement never waits on a row lock (FOR UPDATE SKIP LOCKED): a row an admin is
 * suspending, or the user is changing the email of, is skipped and the sign-in goes through uncounted.
 */
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { log } from '@/lib/logger';

/** A second sign-in inside this window is the same visit (double submit, 2FA retry): stamped once. */
export const SIGN_IN_THROTTLE_MINUTES = 5;
/** A sign-in never waits longer than this for the stamp (pool exhausted, database slow). */
export const RECORD_SIGN_IN_TIMEOUT_MS = 3000;

/** True when a row was stamped; false when throttled, locked, or the user has no profile row yet. */
export async function recordSignIn(userId: string): Promise<boolean> {
  const result = await migrationAdminPool().query(
    `WITH due AS (
       SELECT id FROM users
        WHERE id = $1
          AND (last_login IS NULL OR last_login < NOW() - make_interval(mins => $2::int))
        FOR UPDATE SKIP LOCKED
     )
     UPDATE users u
        SET last_login = NOW(), login_count = u.login_count + 1
       FROM due
      WHERE u.id = due.id`,
    [userId, SIGN_IN_THROTTLE_MINUTES],
  );
  return result.rowCount === 1;
}

/** recordSignIn that can never fail or hold up a sign-in: a failure is logged and swallowed. */
export async function recordSignInSafely(userId: string, via: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      recordSignIn(userId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${RECORD_SIGN_IN_TIMEOUT_MS} ms`)), RECORD_SIGN_IN_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    log.warn('sign-in not recorded', { userId, via, message: err instanceof Error ? err.message : String(err) }, 'Auth');
  } finally {
    clearTimeout(timer);
  }
}
