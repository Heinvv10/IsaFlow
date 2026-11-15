/**
 * The invitee's users row, written in the accept transaction by both accept routes:
 * POST /api/invitations/[token]/accept (sets a password, signs in) and
 * POST /api/invite/[token] (already signed in).
 *
 * company_users_user_id_fkey (migrations 996/997, DEFERRABLE INITIALLY DEFERRED)
 * refuses a membership whose users row is missing at COMMIT, so a route that adds
 * the membership must write this row in the same transaction. Call it AFTER the
 * membership upsert: company_users, then users, is the lock order every writer of a
 * user's rows keeps (admin .claude.md, "Lock order for a user's rows").
 */
import type { PoolClient } from 'pg';

/** What the routes answer for EMAIL_IN_USE (409). */
export const EMAIL_IN_USE_MESSAGE =
  'This email is already attached to a different IsaFlow profile. Ask an administrator to resolve it before accepting.';

export interface InviteeProfile {
  userId: string;
  /** The invitation's address; written only when the row is created. */
  email: string;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Creates the users row, or fills an existing row's missing names. Returns
 * 'email_in_use' when another users row holds this address under a different id:
 * that 23505 has aborted the transaction, so the caller must roll back before
 * anything else runs on `client`. Any other error is thrown.
 *
 * `users` carries users_email_key UNIQUE (email) as well as its primary key, and the
 * INSERT arbitrates only on `id`. Another row holding this address under a different
 * id (a pre-GoTrue-cutover profile, a deleted-and-recreated GoTrue identity) raised
 * 23505, which escaped as an opaque 500 the invitee could do nothing about. Answered
 * from the violation itself rather than from a preceding SELECT: a pre-check cannot
 * close the window between the read and the write, so the same condition answered a
 * clear 409 when it was pre-existing and an opaque 500 when it was concurrent, and it
 * cost an extra round-trip on every accept. The unique index is the authority.
 */
export async function upsertInviteeProfile(
  client: PoolClient, p: InviteeProfile,
): Promise<'ok' | 'email_in_use'> {
  try {
    await client.query(
      // No `email = EXCLUDED.email` on the conflict branch: that reverted the
      // profile email of an account that had changed it, every time its owner
      // accepted an invitation. The row's own email stays its own.
      // onboarding_completed: no new-company wizard for a member (an admin's reset to false is kept).
      `INSERT INTO users (id, email, first_name, last_name, is_active, onboarding_completed)
       VALUES ($1, $2, $3, $4, true, true)
       ON CONFLICT (id) DO UPDATE SET
         first_name = COALESCE(EXCLUDED.first_name, users.first_name),
         last_name  = COALESCE(EXCLUDED.last_name,  users.last_name),
         onboarding_completed = COALESCE(users.onboarding_completed, true)`,
      [p.userId, p.email, p.firstName, p.lastName],
    );
    return 'ok';
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'users_email_key') return 'email_in_use';
    throw err;
  }
}
