// pages/api/auth/register.ts
import type { NextApiHandler } from 'next';
import { adminCreateUser, adminDeleteUser, adminGetUserByEmail } from '@/lib/auth/gotrue';
import { createEmailVerificationToken } from '@/lib/auth/emailVerificationService';
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
  // behaved differently) and a latent data bug. We do not confirm existence; the
  // message points existing users to sign in without asserting the email is taken.
  let emailExists = false;
  try {
    await adminGetUserByEmail(cleanEmail);
    emailExists = true;
  } catch {
    emailExists = false; // not found (or lookup failed) → proceed with registration
  }
  if (emailExists) {
    return res.status(400).json({
      success: false,
      error: { code: 'REGISTRATION_FAILED', message: 'Unable to complete registration. If you already have an account, please sign in.' },
    });
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

  // 3. Email the verification link. Awaited, unlike forgot-password: there is no
  //    enumeration timing channel to protect here (an existing email already
  //    returns a distinct 400 above), and the user needs to know if we could not
  //    send it — otherwise they wait forever for a mail that never left.
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
    return res.status(502).json({
      success: false,
      error: {
        code: 'EMAIL_SEND_FAILED',
        message: 'We could not send your confirmation email. Please try again shortly.',
      },
    });
  }

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
