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
 * 'email_in_use', having created nothing, when the row would be new and another
 * users row holds this address under a different id, in any letter case. The caller
 * must roll back before anything else runs on `client` (a 23505 has aborted the
 * transaction). Any other error is thrown.
 *
 * Letter case (brk-1440): users_email_key is UNIQUE (email), case-sensitive, so an
 * address held as `A@x` let a new row take `a@x`, a second profile for one mailbox.
 * The SELECT below refuses that first. It runs only when this id has no row yet: an
 * existing profile's email is never written here, so it accepts as before. Two NEW
 * invitees whose addresses differ only in case, accepting at the same instant, can
 * still both pass it; a unique index on lower(email) would close that (production
 * held no mixed-case or case-duplicate address on 2026-11-15).
 *
 * `users` carries users_email_key UNIQUE (email) as well as its primary key, and the
 * INSERT arbitrates only on `id`. Another row holding this address under a different
 * id (a pre-GoTrue-cutover profile, a deleted-and-recreated GoTrue identity) raised
 * 23505, which escaped as an opaque 500 the invitee could do nothing about. The
 * exact-case conflict is still answered from the violation itself, not only from the
 * SELECT: a read cannot close the window before the write, and a concurrent row would
 * otherwise turn the same condition into an opaque 500. The unique index is the
 * authority for exact case.
 */
export async function upsertInviteeProfile(
  client: PoolClient, p: InviteeProfile,
): Promise<'ok' | 'email_in_use'> {
  const held = await client.query(
    `SELECT 1 FROM users o
      WHERE lower(o.email) = lower($2) AND o.id <> $1
        AND NOT EXISTS (SELECT 1 FROM users s WHERE s.id = $1)
      LIMIT 1`,
    [p.userId, p.email],
  );
  if ((held.rowCount ?? 0) > 0) return 'email_in_use';
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
