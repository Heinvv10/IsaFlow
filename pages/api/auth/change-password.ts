// pages/api/auth/change-password.ts
import type { NextApiHandler } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { signIn, adminUpdateUser } from '@/lib/auth/gotrue';

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
  // Match the frontend /my-account form's 8-char minimum so users don't hit
  // a silent 400 after passing client-side validation.
  if (newPassword.length < 8) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters' } });
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

export default withUserAuth(handler);
