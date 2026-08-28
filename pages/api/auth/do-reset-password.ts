// pages/api/auth/do-reset-password.ts
import type { NextApiHandler } from 'next';
import { adminUpdateUser } from '@/lib/auth/gotrue';
import { revokeAllSessions } from '@/lib/auth/sessionRevocation';
import { consumePasswordResetToken } from '@/lib/auth/passwordResetService';
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
  if (newPassword.length < 10 || newPassword.length > 200) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be between 10 and 200 characters' } });
  }
  try {
    // Self-owned single-use token (see passwordResetService). Consuming it both
    // validates the reset and binds it to exactly one account. These tokens are
    // minted only by forgot-password, so — unlike a GoTrue session JWT — no
    // magiclink/impersonation/login session can be replayed to drive a reset.
    const consumed = await consumePasswordResetToken(recoveryToken);
    if (!consumed) {
      // Genuinely invalid/expired/already-used token — the only 400 path.
      return res.status(400).json({ success: false, error: { code: 'INVALID_RECOVERY_TOKEN', message: 'Invalid or expired reset link' } });
    }
    // Token was valid and is now spent. A failure here is a server-side problem
    // (DB / GoTrue), NOT a bad token — surface it as 500 so the user retries the
    // whole flow rather than being told their fresh link was "invalid".
    const updated = await adminUpdateUser(consumed.userId, { password: newPassword });
    // SECURITY: a reset is compromise recovery. adminUpdateUser only rotates the
    // password hash — GoTrue's stateless HS256 refresh tokens survive it, so a
    // stolen token would keep refreshing after the reset. Revoke ALL sessions
    // globally (see sessionRevocation.ts). Fail closed: if this throws it is
    // caught below and surfaced as a 500 so the user is never told the reset
    // succeeded while stale sessions may still be live.
    await revokeAllSessions(updated.email, newPassword);
    return res.status(200).json({ success: true, data: null });
  } catch (err) {
    log.error('reset-password failed after token validation', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
    return res.status(500).json({ success: false, error: { code: 'RESET_FAILED', message: 'Could not update password. Please request a new reset link.' } });
  }
};

export default withRateLimit(handler, { max: 10, windowSecs: 900 }, 'do-reset-password');
