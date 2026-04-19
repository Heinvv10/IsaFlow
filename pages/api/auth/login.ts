// pages/api/auth/login.ts
import type { NextApiHandler } from 'next';
import { signIn } from '@/lib/auth/gotrue';
import { listFactors, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { setAuthCookies, setActiveCompanyCookie } from '@/lib/auth/cookies';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'email and password required' } });
  }

  let token;
  try {
    token = await signIn(email.toLowerCase().trim(), password);
  } catch (err) {
    log.info('login failed', { email, message: err instanceof Error ? err.message : 'unknown' }, 'Auth');
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
  }

  // MFA gate: if the user has any verified factor, withhold cookies and ask for a code.
  // Fail-closed on GoTrue error per spec — do not silently log in.
  let verified;
  try {
    const factors = await listFactors(token.access_token);
    verified = factors.totp.filter((f) => f.status === 'verified');
  } catch (err) {
    log.error('login: listFactors failed — failing closed', { message: err instanceof Error ? err.message : 'unknown' }, 'Auth');
    if (err instanceof GotrueMfaError) {
      return res.status(503).json({ success: false, error: { code: 'MFA_CHECK_UNAVAILABLE', message: 'Sign-in temporarily unavailable. Please try again.' } });
    }
    return res.status(503).json({ success: false, error: { code: 'MFA_CHECK_UNAVAILABLE', message: 'Sign-in temporarily unavailable. Please try again.' } });
  }

  if (verified.length > 0) {
    return res.status(200).json({
      success: true,
      data: {
        requires_2fa: true,
        factor_id: verified[0]!.id,
        pending_token: token.access_token,
      },
    });
  }

  // No MFA — set cookies and sign in directly.
  const memberships = await sql<{ company_id: string; is_default: boolean; created_at: Date }>`
    SELECT company_id, is_default, created_at
    FROM company_users
    WHERE user_id = ${token.user.id}
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `;

  setAuthCookies(res, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
  });
  if (memberships.length > 0) setActiveCompanyCookie(res, memberships[0]!.company_id);

  return res.status(200).json({
    success: true,
    data: {
      user: { id: token.user.id, email: token.user.email },
      activeCompanyId: memberships[0]?.company_id ?? null,
    },
  });
};

export default handler;
