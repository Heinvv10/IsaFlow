// pages/api/auth/do-reset-password.ts
import type { NextApiHandler } from 'next';
import { verifyToken, adminUpdateUser } from '@/lib/auth/gotrue';
import { withRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { recoveryToken, newPassword } = req.body ?? {};
  if (typeof recoveryToken !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'recoveryToken and newPassword required' } });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters' } });
  }
  try {
    const claims = await verifyToken(recoveryToken);
    // Pentest L2: ensure this is a GoTrue "recovery" token specifically.
    // Previously, any valid GoTrue access token (e.g. a normal session JWT)
    // would pass verifyToken and could then reset any account referenced by
    // `sub`. Recovery tokens carry `type: 'recovery'` in their claims.
    const claimType = (claims as unknown as { type?: unknown }).type;
    if (claimType !== 'recovery') {
      log.warn('reset-password rejected — token is not a recovery token', { claimType }, 'Auth');
      return res.status(400).json({ success: false, error: { code: 'INVALID_RECOVERY_TOKEN', message: 'Invalid or expired reset link' } });
    }
    await adminUpdateUser(claims.sub, { password: newPassword });
    return res.status(200).json({ success: true, data: null });
  } catch (err) {
    log.info('reset-password failed', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
    return res.status(400).json({ success: false, error: { code: 'INVALID_RECOVERY_TOKEN', message: 'Invalid or expired reset link' } });
  }
};

export default withRateLimit(handler, { max: 10, windowSecs: 900 });
