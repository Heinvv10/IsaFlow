/**
 * POST /api/auth/change-email
 *
 * Body: { newEmail, currentPassword }
 *
 * Changes the user's login email immediately after re-authenticating with
 * the current password. We use the GoTrue admin endpoint with
 * `email_confirm: true` to skip the secure-email-change double-confirm:
 * requiring clicks from both the old and new address was causing users
 * to get locked out (they'd click the new-address link only, leaving
 * the old address as the still-active login email).
 *
 * The password re-auth is the security gate — a stolen session cookie
 * alone can't pivot the login email because the attacker doesn't have
 * the password. Belt-and-braces: rate-limited 5/15min per user.
 *
 * public.users.email is kept in sync in the same request so downstream
 * queries (invoices, audit logs, admin UI) don't drift.
 */

import type { NextApiHandler } from 'next';
import { z } from 'zod';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { signIn, adminUpdateUser } from '@/lib/auth/gotrue';
import { withRateLimit } from '@/lib/rateLimit';
import { sql } from '@/lib/neon';
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

  try {
    await signIn(user.email, currentPassword);
  } catch {
    return res.status(400).json({
      success: false,
      error: { code: 'WRONG_PASSWORD', message: 'Current password is incorrect' },
    });
  }

  try {
    await adminUpdateUser(user.id, { email: normalisedNew, email_confirm: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('change-email: gotrue rejected', { userId: user.id, message: msg }, 'Auth');
    if (/422|already|exists|duplicate/i.test(msg)) {
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_TAKEN', message: 'That email address is already in use' },
      });
    }
    return res.status(502).json({
      success: false,
      error: { code: 'GOTRUE_ERROR', message: 'Could not change email. Please try again.' },
    });
  }

  // Mirror to public.users. GoTrue is now the source of truth for login —
  // if this UPDATE fails, the login email has still changed, so we log and
  // continue rather than rolling back (which we can't do cleanly anyway).
  try {
    await sql`
      UPDATE users SET email = ${normalisedNew}, updated_at = NOW()
      WHERE id = ${user.id}
    `;
  } catch (err) {
    log.error('change-email: public.users mirror failed — drift', {
      userId: user.id,
      newEmail: normalisedNew,
      message: err instanceof Error ? err.message : 'unknown',
    }, 'Auth');
  }

  log.info('change-email: swapped', { userId: user.id, from: user.email.toLowerCase(), to: normalisedNew }, 'Auth');
  return res.status(200).json({
    success: true,
    data: { email: normalisedNew, message: 'Email changed. Use your new email address next time you sign in.' },
  });
};

export default withRateLimit(withUserAuth(withCsrf(handler)), { max: 5, windowSecs: 900 }, 'change-email');
