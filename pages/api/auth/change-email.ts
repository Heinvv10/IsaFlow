/**
 * POST /api/auth/change-email
 *
 * Body: { newEmail, currentPassword }
 *
 * Starts a self-service email change. We re-auth with the current password
 * first (belt-and-braces: a stolen session cookie alone can't pivot a
 * user's login email), then PUT /user on GoTrue with the new address.
 *
 * GoTrue does not swap the email immediately — it sends a confirmation
 * link to the NEW address. The change only takes effect when the user
 * clicks that link. The old email continues to work until then.
 */

import type { NextApiHandler } from 'next';
import { z } from 'zod';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { signIn, userUpdateSelf } from '@/lib/auth/gotrue';
import { parseCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { withRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';

const Body = z.object({
  newEmail: z.email('Invalid email address').max(254),
  currentPassword: z.string().min(1, 'Current password required'),
});

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }

  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
    });
  }
  const { newEmail, currentPassword } = parsed.data;

  const user = (req as UserAuthedRequest).user;
  if (!user.email) {
    return res.status(400).json({ success: false, error: { code: 'NO_EMAIL', message: 'User email missing in token' } });
  }

  const normalisedNew = newEmail.trim().toLowerCase();
  if (normalisedNew === user.email.toLowerCase()) {
    return res.status(400).json({
      success: false,
      error: { code: 'SAME_EMAIL', message: 'New email is the same as the current one' },
    });
  }

  // Re-auth with the current password.
  try {
    await signIn(user.email, currentPassword);
  } catch {
    return res.status(400).json({
      success: false,
      error: { code: 'WRONG_PASSWORD', message: 'Current password is incorrect' },
    });
  }

  // Need the user's own access token to call GoTrue PUT /user (it's a
  // user-level endpoint, not admin).
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Access token missing' } });
  }

  try {
    await userUpdateSelf(token, { email: normalisedNew });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('change-email: gotrue rejected', { userId: user.id, message: msg }, 'Auth');
    // Common GoTrue 4xx: email already in use.
    if (/422|already|exists/i.test(msg)) {
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_TAKEN', message: 'That email address is already in use' },
      });
    }
    return res.status(502).json({
      success: false,
      error: { code: 'GOTRUE_ERROR', message: 'Could not start email change. Please try again.' },
    });
  }

  log.info('change-email: confirmation sent', { userId: user.id, newEmail: normalisedNew }, 'Auth');
  return res.status(200).json({
    success: true,
    data: { message: `Confirmation link sent to ${normalisedNew}. Click it to complete the change. Your current email stays active until then.` },
  });
};

export default withRateLimit(withUserAuth(handler), { max: 5, windowSecs: 900 });
