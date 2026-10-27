// src/lib/auth/inviteAccount.ts
import { adminCreateUser, findUserByEmail } from './gotrue';
import { adminListUserFactors, GotrueMfaError, listFactors, type Factor } from './gotrue-mfa';
import { AuthUpstreamUnavailableError } from './authUpstream';

/** The strength floor for a password being SET (register.ts, do-reset-password.ts). */
export const MIN_NEW_PASSWORD_LENGTH = 10;

export interface InvitationAccount {
  id: string;
  /** Created by this accept, so it can have no second factor yet. */
  created: boolean;
}

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
 * never created over. Concurrent accepts converge: the second create 422s and
 * adminCreateUser answers the first one's account.
 */
export async function resolveInvitationAccount(
  inv: { email: string; gotrue_user_id: string | null },
  password: string,
): Promise<InvitationAccount | null> {
  if (inv.gotrue_user_id) return { id: inv.gotrue_user_id, created: false };
  const existing = await findUserByEmail(inv.email);
  if (existing) return { id: existing.id, created: false };
  if (password.length < MIN_NEW_PASSWORD_LENGTH) return null;
  return { id: (await adminCreateUser({ email: inv.email, email_confirm: true })).id, created: true };
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
