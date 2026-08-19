// pages/api/auth/register.ts
import type { NextApiHandler } from 'next';
import { adminCreateUser, adminDeleteUser, adminGetUserByEmail, type GoTrueUser } from '@/lib/auth/gotrue';
import {
  createEmailVerificationToken,
  invalidateVerificationTokensForUser,
  purgeExpiredVerificationTokens,
} from '@/lib/auth/emailVerificationService';
import { emailLayout, ctaButton } from '@/lib/email-templates-shared';
import { withRateLimit, checkRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import type { SignupType } from '@/modules/onboarding/services/tenantProvisioningService';

/** Sanity ceiling on declared turnover: R100bn. Above this it's a typo or junk. */
const MAX_TURNOVER_CENTS = 10_000_000_000_000;

/**
 * Declared annual turnover (whole ZAR, as typed by the user) → cents.
 * Returns null for absent/blank/unparseable input — undeclared, NOT zero.
 */
function parseTurnoverToCents(raw: unknown): number | null | 'invalid' {
  if (raw === null || raw === undefined || raw === '') return null;
  const numeric =
    typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0) return 'invalid';
  const cents = Math.round(numeric * 100);
  return cents > MAX_TURNOVER_CENTS ? 'invalid' : cents;
}

/**
 * Drop expired verification tokens so the table stays bounded on an open
 * registration endpoint. Token rows only — deleting the GoTrue users behind them
 * would race with a signup verifying in the same moment. Never throws.
 */
async function sweepExpiredTokens(): Promise<void> {
  try {
    const removed = await purgeExpiredVerificationTokens();
    if (removed > 0) log.info('swept expired verification tokens', { removed }, 'auth');
  } catch (err) {
    log.error('expired-token sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    }, 'auth');
  }
}

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
  }
  const { email, password, firstName, lastName, companyName, signupType, annualTurnover, phone } =
    req.body ?? {};
  for (const [name, v] of [['email', email], ['password', password], ['companyName', companyName]] as const) {
    if (typeof v !== 'string' || v.trim().length < 2) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: `${name} required` } });
    }
  }
  if ((password as string).length < 10) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters' } });
  }

  const cleanEmail = (email as string).toLowerCase().trim();
  const cleanSignupType: SignupType = signupType === 'accountant' ? 'accountant' : 'direct';

  const turnoverCents = parseTurnoverToCents(annualTurnover);
  if (turnoverCents === 'invalid') {
    return res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Annual turnover must be a positive amount in rands' },
    });
  }

  // A1-6: per-email registration throttle. The per-IP limit (export below) is
  // defeated by IP rotation; a per-email cap slows enumeration/abuse that probes
  // many passwords or re-registers the same address. Generic 429 either way.
  const emailAllowed = await checkRateLimit(`register:email:${cleanEmail}`, { max: 5, windowSecs: 3600 });
  if (!emailAllowed) {
    return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' } });
  }

  // A1-6: reject an already-registered email with a GENERIC message BEFORE doing
  // any work. adminCreateUser silently returns the existing user on a 422, which
  // previously let register create a SECOND company + owner membership for that
  // user and then fail at signIn — both an enumeration signal (existing vs new
  // behaved differently) and a latent data bug.
  //
  // But "exists" must mean CONFIRMED. Registration is public and proves nothing
  // about who owns the address, so treating any unconfirmed user as taken lets
  // anyone permanently squat a stranger's email: the victim could never register
  // (blocked here), never sign in (unconfirmed), and never verify (they never
  // got the link). An unconfirmed user is an abandoned or squatted signup with
  // nothing attached to it — no company, no membership — so it is safe to
  // discard and let the new request through. A confirmed account is never
  // touched by this path.
  //
  // Residual risk, accepted: this converts a permanent squat into a repeatable
  // one. An attacker who re-registers the address every time the real owner
  // signs up — before the owner clicks their link — invalidates the owner's
  // token each round, so the owner's link 410s. They are never permanently
  // locked out (the next signup works), and the per-email limit caps this at
  // 5/hour, but it is griefing that a CAPTCHA or a verified-sender check would
  // close and this does not.
  let existing: GoTrueUser | null = null;
  try {
    existing = await adminGetUserByEmail(cleanEmail);
  } catch {
    existing = null; // not found (or lookup failed) → proceed with registration
  }

  if (existing?.email_confirmed_at) {
    return res.status(400).json({
      success: false,
      error: { code: 'REGISTRATION_FAILED', message: 'Unable to complete registration. If you already have an account, please sign in.' },
    });
  }

  if (existing) {
    // Unconfirmed leftover. Delete it (which orphans its token rows, swept by
    // purgeExpiredVerificationTokens) so the address is registerable again.
    try {
      // Kill its tokens first. Deleting the GoTrue user does not touch them, and
      // company_users.user_id has no foreign key — so a leftover link would
      // still provision a tenant owned by a user that no longer exists.
      const killed = await invalidateVerificationTokensForUser(existing.id);
      await adminDeleteUser(existing.id);
      log.info('discarded unconfirmed signup to allow re-registration', {
        userId: existing.id,
        tokensInvalidated: killed,
      }, 'auth');
    } catch (err) {
      log.error('could not discard unconfirmed signup', {
        userId: existing.id,
        error: err instanceof Error ? err.message : String(err),
      }, 'auth');
      return res.status(503).json({
        success: false,
        error: { code: 'REGISTRATION_FAILED', message: 'Unable to complete registration. Please try again shortly.' },
      });
    }
  }

  // 1. Create the GoTrue user UNCONFIRMED. GoTrue refuses sign-in for an
  //    unconfirmed address (400 email_not_confirmed, verified against the dev
  //    instance), so this account is inert until the emailed link is consumed.
  const gotrueUser = await adminCreateUser({
    email: cleanEmail,
    password: password as string,
    email_confirm: false,
  });

  // 2. Park the tenant details against a single-use token. NOTHING durable is
  //    created for an unverified address — no company, no subscription, no
  //    membership, and no ops notification. Registration is public, so an
  //    unverified signup must cost one row and one email, nothing more.
  let token: string;
  try {
    ({ token } = await createEmailVerificationToken(gotrueUser.id, {
      email: cleanEmail,
      firstName: typeof firstName === 'string' ? firstName.trim() : null,
      lastName: typeof lastName === 'string' ? lastName.trim() : null,
      companyName: (companyName as string).trim(),
      phone: typeof phone === 'string' && phone.trim() ? phone.trim() : null,
      annualTurnoverCents: turnoverCents,
      signupType: cleanSignupType,
    }));
  } catch (err) {
    // Delete the GoTrue user rather than leave an unverifiable orphan: the
    // adminGetUserByEmail pre-check above would otherwise reject every retry,
    // making this address permanently unregisterable.
    await adminDeleteUser(gotrueUser.id).catch((cleanupErr: unknown) =>
      log.error(
        'orphaned GoTrue user cleanup failed — this email can no longer register',
        {
          userId: gotrueUser.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        },
        'auth',
      ),
    );
    throw err;
  }

  // 3. Email the verification link. Awaited, unlike forgot-password: the user
  //    needs to know if we could not send it, otherwise they wait forever for a
  //    mail that never left.
  //
  //    This does leave a timing difference between a confirmed-existing address
  //    (one lookup, fast 400) and a new one (create + insert + awaited SMTP).
  //    That channel is redundant here: the 400 above already discloses that a
  //    confirmed account exists, by design, so timing reveals nothing the
  //    response body doesn't. forgot-password is the opposite case — it must
  //    return an identical 200 either way, which is why it detaches the send.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  // Fragment, not query string: fragments are never sent to the server, logged,
  // put in a Referer header, or seen by the analytics tracker on every page.
  const verifyUrl = `${appUrl}/verify-email#token=${token}`;
  try {
    await sendEmail({
      to: cleanEmail,
      subject: 'Confirm your email to activate ISAFlow',
      html: emailLayout(`
        <h2>Confirm your email</h2>
        <p>Thanks for signing up for ISAFlow. Confirm this address to activate your account and start your 14-day trial.</p>
        ${ctaButton('Confirm my email', verifyUrl)}
        <p style="font-size:12px;color:#94a3b8;">This link expires in 24 hours and can be used once. If you did not sign up for ISAFlow, you can safely ignore this email — no account will be created.</p>
      `),
      _log: { companyId: null, emailType: 'other', sentBy: null },
    });
  } catch (err) {
    log.error('verification email failed to send', {
      userId: gotrueUser.id,
      error: err instanceof Error ? err.message : String(err),
    }, 'auth');
    // Undo the signup. Without this the address is left holding an unconfirmed
    // user and a token whose link never arrived — unusable, and (before the
    // recycle above) unregisterable. Delete the user so a retry starts clean;
    // its token rows are orphaned and swept by purgeExpiredVerificationTokens.
    await adminDeleteUser(gotrueUser.id).catch((cleanupErr: unknown) =>
      log.error(
        'orphaned GoTrue user cleanup failed after send failure',
        {
          userId: gotrueUser.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        },
        'auth',
      ),
    );
    return res.status(502).json({
      success: false,
      error: {
        code: 'EMAIL_SEND_FAILED',
        message: 'We could not send your confirmation email. Please try again shortly.',
      },
    });
  }

  // Opportunistic sweep. Registration is the only thing that creates these rows,
  // so it is the only place their volume grows — sweeping here keeps the table
  // bounded without standing up a cron. Fires only on a signup that actually
  // landed, and detached, so it never delays or breaks the request.
  void sweepExpiredTokens();

  log.info('signup pending verification', {
    userId: gotrueUser.id,
    signupType: cleanSignupType,
  }, 'auth');

  // 202: accepted, not yet complete. No auth cookies — the caller is not signed
  // in until they confirm.
  return res.status(202).json({
    success: true,
    data: { pendingVerification: true, email: cleanEmail },
  });
};

export default withRateLimit(handler, { max: 5, windowSecs: 3600 });
