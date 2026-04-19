// pages/api/auth/2fa-status.ts
// Tiny wrapper over GoTrue listFactors — gives the my-account UI a single
// GET to check whether TOTP is enabled.
import type { NextApiHandler } from 'next';
import { parseCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { listFactors, GotrueMfaError } from '@/lib/auth/gotrue-mfa';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET required' } });
  }
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }
  try {
    const factors = await listFactors(token);
    const verified = factors.totp.find((f) => f.status === 'verified');
    return res.status(200).json({
      success: true,
      data: { enabled: !!verified, factor_id: verified?.id ?? null },
    });
  } catch (err) {
    if (err instanceof GotrueMfaError) {
      return res.status(err.status).json({ success: false, error: { code: 'STATUS_FAILED', message: err.message } });
    }
    throw err;
  }
};

export default handler;
