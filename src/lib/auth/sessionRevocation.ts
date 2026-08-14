// src/lib/auth/sessionRevocation.ts
//
// Compromise-recovery session revocation for the password change / reset flows.
//
// WHY THIS EXISTS
// GoTrue access/refresh tokens are stateless HS256 JWTs. `adminUpdateUser({
// password })` only rotates the stored password hash — it does NOT revoke any
// existing session. So an attacker holding a stolen refresh token keeps a live
// session through /api/auth/refresh indefinitely, even AFTER the victim
// "secures" the account by changing or resetting the password. Revoking the
// old refresh tokens is the whole point of a compromise-triggered password
// change, and only GoTrue's /logout endpoint does that.
//
// WHY THE /logout MECHANISM (API) AND NOT A DB DELETE
//   - GoTrue exposes no admin "log out user by id" route: POST
//     /admin/users/{id}/logout returns 404 on this deployment. The only
//     session-revoking endpoint is POST /logout, which acts on the user that
//     owns the presented access token (with a `scope`).
//   - A direct DELETE from auth.refresh_tokens is unreachable: GoTrue's `auth`
//     schema lives in a SEPARATE database from the app's DATABASE_URL
//     (isaflow_dev / isaflow) — `auth.refresh_tokens` does not exist there — so
//     no configured pool can touch it. The API is the correct, reachable tool.
//
// Both helpers mint a session from the NEW password purely to obtain a token to
// present to /logout, then revoke. They THROW if GoTrue is unreachable — a
// caller must never report "your account is secured" when stale sessions may
// still be live.

import { signIn, logout } from './gotrue';
import type { GoTrueTokenResponse } from './gotrue';

/**
 * Self-service password CHANGE: revoke every OTHER session while keeping the
 * caller logged in. Mints a fresh session from the new password, then
 * /logout?scope=others revokes all pre-existing refresh tokens (a stolen one
 * included) EXCEPT the freshly minted one. The returned token pair must be
 * written to the caller's cookies so their current browser stays authenticated
 * on the surviving session (their previous cookie counts as an "other" session
 * and is now revoked).
 *
 * GUARANTEE: on success, only the returned session can refresh; every session
 * that existed before the change is dead.
 */
export async function rotateSessionRevokingOthers(
  email: string,
  newPassword: string,
): Promise<GoTrueTokenResponse> {
  const fresh = await signIn(email, newPassword);
  await logout(fresh.access_token, 'others');
  return fresh;
}

/**
 * Password RESET (forgot-password flow): revoke ALL sessions globally. A reset
 * is compromise recovery with no live caller session to preserve — the UX
 * redirects to login — so a throwaway session is minted from the new password
 * purely to obtain a token, then /logout (global) revokes every refresh token
 * including it.
 *
 * GUARANTEE: on success, no session that existed before the reset can refresh.
 */
export async function revokeAllSessions(email: string, newPassword: string): Promise<void> {
  const tmp = await signIn(email, newPassword);
  await logout(tmp.access_token, 'global');
}
