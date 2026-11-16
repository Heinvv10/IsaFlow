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
import { isUsersEmailTaken } from './usersEmailUnique';

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
 * 'email_in_use', having created nothing, when the row would be new and another
 * users row holds this address under a different id, in any letter case or
 * padding. The caller must roll back before anything else runs on `client` (the
 * 23505 has aborted the transaction). Any other error is thrown.
 *
 * The address is stored lower(btrim(email)), the form users_email_lower_key
 * (migration 999) holds unique. That index is the guarantee, not a read before
 * the write: a read cannot see another transaction's uncommitted row, so two new
 * invitees whose addresses differed only in case both passed the lower() SELECT
 * this helper used to run (brk-1440). Now the second INSERT waits on the first
 * and fails when it commits. A row stored in mixed case before 999 is never
 * rewritten; the index still compares its normal form.
 *
 * The INSERT arbitrates only on `id`, so a conflict on either email key raises
 * 23505 (`isUsersEmailTaken`) rather than taking the DO UPDATE branch, and an
 * existing profile (same id) never reaches those keys: its email is not written.
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
       VALUES ($1, lower(btrim($2)), $3, $4, true, true)
       ON CONFLICT (id) DO UPDATE SET
         first_name = COALESCE(EXCLUDED.first_name, users.first_name),
         last_name  = COALESCE(EXCLUDED.last_name,  users.last_name),
         onboarding_completed = COALESCE(users.onboarding_completed, true)`,
      [p.userId, p.email, p.firstName, p.lastName],
    );
    return 'ok';
  } catch (err) {
    if (isUsersEmailTaken(err)) return 'email_in_use';
    throw err;
  }
}
