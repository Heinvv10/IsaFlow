// src/lib/auth/inviteAccount.ts
import { adminCreateUser, findUserByEmail } from './gotrue';
import { listFactors } from './gotrue-mfa';

/** The strength floor for a password being SET (register.ts, do-reset-password.ts). */
export const MIN_NEW_PASSWORD_LENGTH = 10;

/**
 * The GoTrue account an invitation is accepted as, or null when the address
 * has no account and `password` is too weak to create one with.
 *
 * POST /api/invitations creates (or finds) that account when it sends the
 * invite and stores it in `gotrue_user_id`. userInvitationService — the
 * Settings -> User Access screen — never did, so its invitees had no way to
 * set a password and join: /accept-invite refused the row and the only other
 * route was the self-serve signup, which creates a SECOND company.
 *
 * Resolved here at accept time instead, and deliberately NOT written back to
 * the invitation: pages/api/invitations/revoke/[id].ts deletes the stored
 * account when it has no memberships, and an account found here may be
 * someone's own login (a pending signup, a member removed everywhere) that
 * this invitation never created. An existing account is always found first,
 * never created over, and the caller's established-account check then demands
 * its current password. Concurrent accepts converge: the second create 422s
 * and adminCreateUser answers the first one's account.
 */
export async function resolveInvitationAccount(
  inv: { email: string; gotrue_user_id: string | null },
  password: string,
): Promise<string | null> {
  if (inv.gotrue_user_id) return inv.gotrue_user_id;
  const existing = await findUserByEmail(inv.email);
  if (existing) return existing.id;
  if (password.length < MIN_NEW_PASSWORD_LENGTH) return null;
  return (await adminCreateUser({ email: inv.email, email_confirm: true })).id;
}

/**
 * Does this signed-in account have a verified second factor? Accepting an
 * invitation with a password must not mint a session that /api/auth/login
 * would have withheld until the code was given. Throws when the factors cannot
 * be read; the caller fails closed.
 */
export async function accountHasVerifiedFactor(accessToken: string): Promise<boolean> {
  const factors = await listFactors(accessToken);
  return factors.totp.some((f) => f.status === 'verified');
}
