// pages/api/auth/change-password.ts
import type { NextApiHandler } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { signIn, adminUpdateUser } from '@/lib/auth/gotrue';
import { AuthUpstreamUnavailableError, respondIfAuthUnavailable, AUTH_RETRY_AFTER_SECS } from '@/lib/auth/authUpstream';
import { rotateSessionRevokingOthers } from '@/lib/auth/sessionRevocation';
import { setAuthCookies, parseCookies, REMEMBER_ME_COOKIE } from '@/lib/auth/cookies';
import { withRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { refuseImpersonatedSession } from '@/lib/auth/impersonationGuard';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  // R-032 (f): a Login-as session changes none of the target's credentials.
  if (await refuseImpersonatedSession(req, res)) return;
  const user = (req as UserAuthedRequest).user;
  // Accept legacy `oldPassword` alongside `currentPassword` — the /my-account
  // form still uses the old field name.
  const body = req.body ?? {};
  const currentPassword = typeof body.currentPassword === 'string'
    ? body.currentPassword
    : typeof body.oldPassword === 'string' ? body.oldPassword : undefined;
  const { newPassword } = body;
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'currentPassword and newPassword required' } });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters' } });
  }
  if (!user.email) {
    return res.status(400).json({ success: false, error: { code: 'NO_EMAIL', message: 'User email missing in token' } });
  }
  const email = user.email;
  try {
    // Re-auth by signing in with the current password — GoTrue will reject if wrong.
    await signIn(email, currentPassword);
  } catch (err) {
    // D9: GoTrue could not answer, so the password was never judged. Never say it is wrong.
    if (respondIfAuthUnavailable(res, err, 'change-password')) return;
    return res.status(400).json({ success: false, error: { code: 'WRONG_PASSWORD', message: 'Current password is incorrect' } });
  }
  try {
    await adminUpdateUser(user.id, { password: newPassword });
  } catch (err) {
    if (!(err instanceof AuthUpstreamUnavailableError)) throw err;
    // D9: the outcome is UNKNOWN — GoTrue may have saved the password and lost the reply. Fail safe: the new
    // password signs in only if the change landed, and then the other sessions are revoked as below.
    try {
      await signIn(email, newPassword);
    } catch (probeErr) {
      if (probeErr instanceof AuthUpstreamUnavailableError) {
        log.warn('change-password: outcome unknown and unverifiable', { userId: user.id }, 'Auth');
        res.setHeader('Retry-After', String(AUTH_RETRY_AFTER_SECS));
        return res.status(503).json({ success: false, error: { code: 'PASSWORD_CHANGE_UNCONFIRMED', message:
          'We could not confirm the change. Your password may have been changed: try signing in with the new one, then sign out of all devices.' } });
      }
      // The new password does not sign in: the change did not land. Nothing changed; a retry is safe.
      respondIfAuthUnavailable(res, err, 'change-password');
      return;
    }
  }

  // SECURITY: adminUpdateUser only rotates the password hash — GoTrue's
  // stateless HS256 refresh tokens survive it, so without this a stolen token
  // keeps refreshing indefinitely after the victim "secures" the account.
  // Revoke every OTHER session, then re-issue THIS caller's cookies from the
  // surviving fresh session so their current browser stays signed in.
  try {
    const fresh = await rotateSessionRevokingOthers(email, newPassword);
    const persistent = parseCookies(req)[REMEMBER_ME_COOKIE] !== '0';
    setAuthCookies(res, {
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token,
      expiresIn: fresh.expires_in,
      persistent,
    });
  } catch (err) {
    // Fail closed: the password WAS changed, but we could not confirm the other
    // sessions were revoked. Never tell the user the account is fully secured
    // when a stale session might still be live.
    log.error(
      'change-password: session revocation failed after password update',
      { userId: user.id, message: err instanceof Error ? err.message : String(err) },
      'Auth',
    );
    return res.status(500).json({
      success: false,
      error: {
        code: 'SESSION_REVOKE_FAILED',
        message: 'Your password was changed, but we could not sign out your other sessions. Please try again or sign out of all devices.',
      },
    });
  }
  return res.status(200).json({ success: true, data: null });
};

export default withRateLimit(withUserAuth(withCsrf(handler)), { max: 10, windowSecs: 900 }, 'change-password');
