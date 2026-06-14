// pages/api/auth/logout.ts
import type { NextApiHandler } from 'next';
import { logout as gotrueLogout } from '@/lib/auth/gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { log } from '@/lib/logger';
import { withCsrf } from '@/lib/auth/withCsrf';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (token) {
    try { await gotrueLogout(token); }
    catch (err) { log.info('gotrue logout non-fatal error', { message: err instanceof Error ? err.message : String(err) }, 'Auth'); }
  }
  clearAuthCookies(res);
  return res.status(200).json({ success: true, data: null });
};

export default withCsrf(handler);
