// pages/api/auth/change-password.ts
import type { NextApiHandler } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { signIn, adminUpdateUser } from '@/lib/auth/gotrue';
import { withRateLimit } from '@/lib/rateLimit';

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
  try {
    // Re-auth by signing in with the current password — GoTrue will reject if wrong.
    await signIn(user.email, currentPassword);
  } catch {
    return res.status(400).json({ success: false, error: { code: 'WRONG_PASSWORD', message: 'Current password is incorrect' } });
  }
  await adminUpdateUser(user.id, { password: newPassword });
  return res.status(200).json({ success: true, data: null });
};

export default withRateLimit(withUserAuth(withCsrf(handler)), { max: 10, windowSecs: 900 });
