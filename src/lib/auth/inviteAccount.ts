// src/lib/auth/inviteAccount.ts
import { adminCreateUser, findUserByEmail } from './gotrue';
import { adminListUserFactors, GotrueMfaError, listFactors, type Factor } from './gotrue-mfa';
import { AuthUpstreamUnavailableError } from './authUpstream';
import { adminGetUser } from './gotrueAdminUser';

/**
 * Is GoTrue account `accountId` an ESTABLISHED IsaFlow login? A `users` row under exactly that id is written only by
 * tenant provisioning (after email verification) and by an invite accept, so its presence means a password already
 * exists. An account without one is a placeholder (POST /api/invitations' adminCreateUser, a pending signup): the
 * anonymous accept sets its password, so whoever holds the invitation link takes it. Judged here once for the accept
 * (pages/api/invitations/[token]/accept.ts) and for an admin's deleteUser, which counts only an established holder of
 * the deleted row's address as someone else (deletedUserInvitations.ts). `db` is the caller's connection (a pg client,
 * or anything with its `query(text, params)` shape).
 */
export async function isEstablishedAccount(
  db: { query(text: string, params: unknown[]): Promise<{ rows: unknown[] }> }, accountId: string,
): Promise<boolean> {
  return (await db.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [accountId])).rows.length > 0;
}

/** The strength floor for a password being SET; the same 10 that register.ts and do-reset-password.ts apply. */
export const MIN_NEW_PASSWORD_LENGTH = 10;

/**
 * The GoTrue account an invitation is accepted as, or null when the address
 * has no account and `password` is too weak to create one with.
 *
 * POST /api/invitations creates (or finds) that account when it sends the
 * invite and stores it in `gotrue_user_id`; userInvitationService (Settings ->
 * User Access) stores the account that holds the address when it sends, and
 * NULL when none does (R7-1). For NULL the account is resolved here at accept
 * time and deliberately NOT written back to the invitation (nothing needs it
 * after the accept). An existing account is always found first,
 * never created over. Concurrent accepts converge: the second create 422s and
 * adminCreateUser answers the first one's account — which is why the caller
 * checks factors for every account without a `users` row, not only found ones.
 */
export async function resolveInvitationAccount(
  inv: { id: string; email: string; gotrue_user_id: string | null },
  password: string,
): Promise<string | null> {
  if (inv.gotrue_user_id) return inv.gotrue_user_id;
  const existing = await findUserByEmail(inv.email);
  if (existing) return existing.id;
  if (password.length < MIN_NEW_PASSWORD_LENGTH) return null;
  // Stamped as POST /api/invitations stamps its own: the account this invitation created (invitationAccountRole).
  return (await adminCreateUser({ email: inv.email, email_confirm: true, user_metadata: { invite_id: inv.id } })).id;
}

const sameAddress = (a: string | null | undefined, b: string): boolean =>
  (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What the anonymous accept may do with account `accountId` (resolveInvitationAccount's answer):
 * - 'mismatch': GoTrue has no such account, or its login email is no longer the invitation's address
 *   (a change-email since the pin): nothing is written, the accept is IDENTITY_MISMATCH.
 * - 'set-password': the account was created FOR this invitation (`user_metadata.invite_id`, stamped by
 *   POST /api/invitations and by resolveInvitationAccount), so the invitee's password becomes its password.
 *   Also an account another invitation created that has never signed in: a placeholder with no owner and no
 *   password yet (two companies inviting one address before either is accepted); the link holder reads the
 *   same mailbox either invitation went to.
 * - 'sign-in': any other account (one that already held the address: a Settings pin since R7-1, a deleted
 *   user's surviving login, a pending signup, any account that has signed in) keeps its own password; the
 *   accept must sign in with it. Never a password write on an account no invitation created.
 * Read before any lock; a GoTrue outage throws AuthUpstreamUnavailableError.
 */
export async function invitationAccountRole(
  inv: { id: string; email: string }, accountId: string,
): Promise<'mismatch' | 'set-password' | 'sign-in'> {
  const account = await adminGetUser(accountId);
  if (account === null || !sameAddress(account.email, inv.email)) return 'mismatch';
  const createdBy = account.user_metadata?.invite_id;
  if (createdBy === inv.id.toLowerCase()) return 'set-password';
  return typeof createdBy === 'string' && !account.last_sign_in_at ? 'set-password' : 'sign-in';
}

/**
 * Has this account a verified second factor? Accepting an invitation with a
 * password must not mint a session, or set a password, that /api/auth/login
 * would have withheld until the code was given. By the signed-in session when
 * there is one, else by the admin API (before any password is touched).
 *
 * Fails closed: an unreadable factor list is an outage (503, attempt refunded),
 * as /api/auth/login answers it, never a pass.
 */
export async function accountHasVerifiedFactor(
  by: { accessToken: string } | { userId: string },
): Promise<boolean> {
  let factors: Factor[];
  try {
    factors = 'accessToken' in by ? (await listFactors(by.accessToken)).totp : await adminListUserFactors(by.userId);
  } catch (err) {
    if (err instanceof GotrueMfaError) {
      throw new AuthUpstreamUnavailableError(`gotrue factor check failed: ${err.status}`, { cause: err });
    }
    throw err;
  }
  return factors.some((f) => f.factor_type === 'totp' && f.status === 'verified');
}
