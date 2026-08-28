// pages/api/auth/change-password.ts
import type { NextApiHandler } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { signIn, adminUpdateUser } from '@/lib/auth/gotrue';
import { rotateSessionRevokingOthers } from '@/lib/auth/sessionRevocation';
import { setAuthCookies, parseCookies, REMEMBER_ME_COOKIE } from '@/lib/auth/cookies';
import { withRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
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
  } catch {
    return res.status(400).json({ success: false, error: { code: 'WRONG_PASSWORD', message: 'Current password is incorrect' } });
  }
  await adminUpdateUser(user.id, { password: newPassword });

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
