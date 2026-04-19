// pages/api/auth/forgot-password.ts
import type { NextApiHandler } from 'next';
import { recoverPassword } from '@/lib/auth/gotrue';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { email } = req.body ?? {};
  if (typeof email !== 'string' || email.length < 3) {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'email required' } });
  }
  // The page lives at /reset-password (not /auth/reset-password). Keep in
  // sync with GOTRUE_URI_ALLOW_LIST — GoTrue refuses redirect_to values
  // that aren't in the allow-list and falls back to SITE_URL, which then
  // bounces unauthenticated users to /login and loses the reset flow.
  const redirectTo =
    (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000') + '/reset-password';
  try {
    await recoverPassword(email.toLowerCase().trim(), redirectTo);
  } catch (err) {
    log.info('gotrue recover non-fatal', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
  }
  // Always return 200 so attackers can't enumerate accounts.
  return res.status(200).json({ success: true, data: null });
};

export default handler;
