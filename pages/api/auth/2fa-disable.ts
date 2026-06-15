// pages/api/auth/2fa-disable.ts
// Disable 2FA: verify a current TOTP code (proves possession), then unenroll.
import type { NextApiHandler } from 'next';
import { parseCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { challengeFactor, verifyFactor, unenrollFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { log } from '@/lib/logger';
import { withCsrf } from '@/lib/auth/withCsrf';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }
  const { factor_id, code } = req.body ?? {};
  if (typeof factor_id !== 'string' || typeof code !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'factor_id and code required' } });
  }
  // Bound TOTP brute-force per factor before allowing a 2FA-disable (pentest H7).
  if (!(await checkRateLimit(`2fa:disable:${factor_id}`, { max: 5, windowSecs: 900 }))) {
    log.warn('2fa-disable rate limit (factor)', { factor_id, ip: getClientIp(req) }, 'Auth');
    return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' } });
  }
  try {
    const challengeId = await challengeFactor(factor_id, token);
    await verifyFactor(factor_id, challengeId, code, token);
    await unenrollFactor(factor_id, token);
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err instanceof GotrueMfaError) {
      log.info('2fa-disable failed', { status: err.status }, 'Auth');
      return res.status(err.status === 422 ? 400 : err.status).json({
        success: false,
        error: { code: err.status === 422 ? 'INVALID_CODE' : 'DISABLE_FAILED', message: 'Invalid verification code' },
      });
    }
    throw err;
  }
};

export default withCsrf(handler);
