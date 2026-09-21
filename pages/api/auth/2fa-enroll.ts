import { IMPERSONATION_PROOF_COOKIE } from '@/lib/auth/impersonation-cookies';
// pages/api/auth/2fa-enroll.ts
import type { NextApiHandler } from 'next';
import { parseCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { enrollTotp, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { verifyToken } from '@/lib/auth/gotrue';
import { log } from '@/lib/logger';
import { withCsrf } from '@/lib/auth/withCsrf';
import { requireActiveAccount } from '@/lib/auth/requireActiveAccount';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const cookies = parseCookies(req);
  const token = cookies[ACCESS_COOKIE];
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }
  let email: string;
  let userId: string;
  try {
    const claims = await verifyToken(token, cookies[IMPERSONATION_PROOF_COOKIE]);
    email = typeof claims.email === 'string' ? claims.email : '';
    userId = claims.sub;
  } catch {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
  }

  // Account-standing gate: a suspended user must not reconfigure the security
  // settings of a closed account.
  const refusal = await requireActiveAccount(userId);
  if (refusal) {
    log.warn('2fa enrol refused — account not in good standing', { userId }, 'Auth');
    return res.status(403).json({ success: false, error: refusal });
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
