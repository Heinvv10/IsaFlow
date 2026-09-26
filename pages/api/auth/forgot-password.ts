// pages/api/auth/forgot-password.ts
import type { NextApiHandler } from 'next';
import { adminGetUserByEmail } from '@/lib/auth/gotrue';
import { sendPasswordResetEmail } from '@/lib/auth/passwordResetEmail';
import { checkRateLimit, getClientIp, withRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';

/**
 * Mint a reset token and email the link. Runs detached from the request so the
 * HTTP response timing does not depend on whether the account exists. Never
 * throws — all failures are logged and swallowed.
 */
async function deliverResetEmail(cleanEmail: string): Promise<void> {
  try {
    const user = await adminGetUserByEmail(cleanEmail);
    await sendPasswordResetEmail(user.id, cleanEmail);
  } catch (err) {
    log.info('forgot-password non-fatal', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
  }
}

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { email } = req.body ?? {};
  if (typeof email !== 'string' || email.length < 3) {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'email required' } });
  }

  const cleanEmail = email.toLowerCase().trim();
  // Per-email limit stops attackers from spamming a single inbox from many IPs.
  const emailAllowed = await checkRateLimit(`forgot:email:${cleanEmail}`, { max: 3, windowSecs: 900 });
  if (!emailAllowed) {
    log.warn('forgot-password rate limit (email)', { email: cleanEmail, ip: getClientIp(req) }, 'Auth');
    // Still return 200 to avoid enumeration.
    return res.status(200).json({ success: true, data: null });
  }

  // Self-owned reset (not GoTrue /recover): mint a single-use token and email
  // our own link. The mint+send runs detached and is NOT awaited, so the
  // response time is identical whether or not the account exists — closing the
  // timing side-channel that would otherwise leak account existence. Every
  // failure (incl. unknown email) is swallowed for the same reason.
  void deliverResetEmail(cleanEmail);
  // Always return 200 so attackers can't enumerate accounts.
  return res.status(200).json({ success: true, data: null });
};

export default withRateLimit(handler, { max: 10, windowSecs: 900 }, 'forgot-password');
