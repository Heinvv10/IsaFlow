// pages/api/auth/2fa-disable.ts
// Disable 2FA: verify a current TOTP code (proves possession), then unenroll.
import type { NextApiHandler } from 'next';
import { parseCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { challengeFactor, verifyFactor, unenrollFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { log } from '@/lib/logger';

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

export default handler;
