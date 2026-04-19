// pages/api/auth/2fa-challenge.ts
// Called by the client after /api/auth/login returns {requires_2fa: true, ...}.
// Completes the GoTrue challenge using the short-lived pending_token, then
// sets the real sb-access-token / sb-refresh-token cookies.
import type { NextApiHandler } from 'next';
import { setAuthCookies, setActiveCompanyCookie } from '@/lib/auth/cookies';
import { challengeFactor, verifyFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { verifyToken } from '@/lib/auth/gotrue';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { factor_id, code, pending_token } = req.body ?? {};
  if (typeof factor_id !== 'string' || typeof code !== 'string' || typeof pending_token !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'factor_id, code, pending_token required' } });
  }

  let userId: string;
  let email: string;
  try {
    const claims = await verifyToken(pending_token);
    userId = claims.sub;
    email = typeof claims.email === 'string' ? claims.email : '';
  } catch {
    return res.status(401).json({ success: false, error: { code: 'INVALID_PENDING_TOKEN', message: 'Pending session expired' } });
  }

  try {
    const challengeId = await challengeFactor(factor_id, pending_token);
    const aal2 = await verifyFactor(factor_id, challengeId, code, pending_token);

    const memberships = await sql<{ company_id: string }>`
      SELECT company_id
      FROM company_users
      WHERE user_id = ${userId}
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1
    `;

    setAuthCookies(res, {
      accessToken: aal2.access_token,
      refreshToken: aal2.refresh_token,
      expiresIn: aal2.expires_in,
    });
    if (memberships.length > 0) setActiveCompanyCookie(res, memberships[0]!.company_id);

    return res.status(200).json({
      success: true,
      data: {
        user: { id: userId, email },
        activeCompanyId: memberships[0]?.company_id ?? null,
      },
    });
  } catch (err) {
    if (err instanceof GotrueMfaError) {
      log.info('2fa-challenge failed', { status: err.status }, 'Auth');
      return res.status(err.status === 422 ? 400 : err.status).json({
        success: false,
        error: { code: err.status === 422 ? 'INVALID_CODE' : 'CHALLENGE_FAILED', message: 'Invalid verification code' },
      });
    }
    throw err;
  }
};

export default handler;
