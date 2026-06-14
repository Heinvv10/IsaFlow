// pages/api/auth/2fa-enroll.ts
import type { NextApiHandler } from 'next';
import { parseCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { enrollTotp, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { verifyToken } from '@/lib/auth/gotrue';
import { log } from '@/lib/logger';
import { withCsrf } from '@/lib/auth/withCsrf';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }
  let email: string;
  try {
    const claims = await verifyToken(token);
    email = typeof claims.email === 'string' ? claims.email : '';
  } catch {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
  }
  try {
    const result = await enrollTotp(token, email);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    if (err instanceof GotrueMfaError) {
      log.warn('2fa-enroll gotrue error', { status: err.status }, 'Auth');
      return res.status(err.status).json({ success: false, error: { code: 'ENROLL_FAILED', message: err.message } });
    }
    throw err;
  }
};

export default withCsrf(handler);
