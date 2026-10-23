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
 * public.users.email is written FIRST, in a transaction on the
 * migration_admin pool, and committed only once GoTrue has accepted the new
 * address, so a definite GoTrue refusal leaves both emails as they were
 * (S-07b follow-up B). Two drifts remain: GoTrue applies the change but its
 * reply is lost (timeout, cut-off body: answered 503 and rolled back here), and
 * the COMMIT fails after GoTrue accepted (logged as drift, 500). While GoTrue
 * is asked, the caller's users row stays locked and one of the pool's two
 * connections is held, for at most the GoTrue call's bound. The service pool may not write users.email at
 * all (migration 918): injected SQL there could otherwise hand any account's
 * address, and with it pending invitations, to someone else.
 */

import type { NextApiHandler } from 'next';
import { z } from 'zod';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { signIn, adminUpdateUser } from '@/lib/auth/gotrue';
import { respondIfAuthUnavailable } from '@/lib/auth/authUpstream';
import { withRateLimit } from '@/lib/rateLimit';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { log } from '@/lib/logger';
import { refuseImpersonatedSession } from '@/lib/auth/impersonationGuard';

const Body = z.object({
  newEmail: z.email('Invalid email address').max(254),
  currentPassword: z.string().min(1, 'Current password required'),
});

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }

  // R-032 (f): a Login-as session changes none of the target's credentials.
  if (await refuseImpersonatedSession(req, res)) return;
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
  } catch (err) {
    // D9: GoTrue could not answer, so the password was never judged. Never say it is wrong.
    if (respondIfAuthUnavailable(res, err, 'change-email')) return;
    return res.status(400).json({
      success: false,
      error: { code: 'WRONG_PASSWORD', message: 'Current password is incorrect' },
    });
  }

  // Fixed statements on the migration_admin pool, keyed on the verified
  // session's user id. The row stays locked and uncommitted while GoTrue is
  // asked; GoTrue's refusal rolls it back.
  const client = await migrationAdminPool().connect();
  let opened = false;
  let unusable = false;
  try {
    opened = true; // before BEGIN (R-176): a BEGIN that reached the server but failed is rolled back too
    await client.query('BEGIN');
    let updated;
    try {
      updated = await client.query(`UPDATE users SET email = $2, updated_at = NOW() WHERE id = $1`, [user.id, normalisedNew]);
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code !== '23505' || pgErr.constraint !== 'users_email_key') throw err;
      unusable = await rollbackFailed(client, 'change-email');
      opened = false;
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_TAKEN', message: 'That email address is already in use' },
      });
    }
    // No profile row: refuse before GoTrue, which would otherwise change a
    // login email that public.users never learns of.
    if (updated.rowCount !== 1) {
      unusable = await rollbackFailed(client, 'change-email');
      opened = false;
      log.warn('change-email: no users row', { userId: user.id, rowCount: updated.rowCount }, 'Auth');
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User profile not found' } });
    }

    try {
      await adminUpdateUser(user.id, { email: normalisedNew, email_confirm: true });
    } catch (err) {
      unusable = await rollbackFailed(client, 'change-email');
      opened = false;
      if (respondIfAuthUnavailable(res, err, 'change-email')) return;
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

    try {
      opened = false;
      await client.query('COMMIT');
    } catch (err) {
      // The one gap left: GoTrue has the new login email, public.users does not.
      unusable = true;
      log.error('change-email: GoTrue changed the login email but the users COMMIT failed — drift', {
        userId: user.id,
        newEmail: normalisedNew,
        message: err instanceof Error ? err.message : 'unknown',
      }, 'Auth');
      return res.status(500).json({
        success: false,
        error: { code: 'EMAIL_SYNC_FAILED', message: 'Your sign-in email changed but your profile was not updated. Please contact support.' },
      });
    }
  } catch (err) {
    if (opened) unusable = await rollbackFailed(client, 'change-email');
    throw err;
  } finally {
    client.release(unusable);
  }

  log.info('change-email: swapped', { userId: user.id, from: user.email.toLowerCase(), to: normalisedNew }, 'Auth');
  return res.status(200).json({
    success: true,
    data: { email: normalisedNew, message: 'Email changed. Use your new email address next time you sign in.' },
  });
};

export default withRateLimit(withUserAuth(withCsrf(handler)), { max: 5, windowSecs: 900 }, 'change-email');
