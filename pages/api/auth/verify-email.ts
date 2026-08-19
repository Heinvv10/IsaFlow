// pages/api/auth/verify-email.ts
/**
 * POST /api/auth/verify-email — consume a signup verification token.
 *
 * This is where a self-serve signup actually becomes a tenant. /api/auth/register
 * only creates an unconfirmed GoTrue user and parks the company details; nothing
 * durable exists until this endpoint runs, so an unverified address can never
 * create a company, a subscription, or an ops notification.
 *
 * Order matters: the token is consumed FIRST (atomically), so a replay or a
 * double-click cannot provision two tenants for one signup.
 */
import type { NextApiHandler } from 'next';
import pg from 'pg';
import { adminUpdateUser } from '@/lib/auth/gotrue';
import { consumeEmailVerificationToken } from '@/lib/auth/emailVerificationService';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { provisionTenant } from '@/modules/onboarding/services/tenantProvisioningService';
import { withRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';

/** Where new-tenant notifications land. Only fires for VERIFIED signups. */
const NOTIFY_TO = 'ai@velocityfibre.co.za';

/** Escape untrusted values before they go into the notification email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function adminPool(): pg.Pool {
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required for verify-email');
  return new pg.Pool({
    connectionString: url,
    max: 2,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
}

const INVALID_TOKEN = {
  success: false,
  error: {
    code: 'INVALID_OR_EXPIRED',
    message: 'This confirmation link is invalid, expired, or already used.',
  },
} as const;

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
  }

  const { token } = req.body ?? {};
  if (typeof token !== 'string' || token.length < 16) {
    return res.status(400).json(INVALID_TOKEN);
  }

  // Consume first: the UPDATE ... WHERE consumed_at IS NULL RETURNING is atomic,
  // so concurrent clicks cannot both proceed to provisioning.
  const consumed = await consumeEmailVerificationToken(token);
  if (!consumed) {
    return res.status(410).json(INVALID_TOKEN);
  }
  const { gotrueUserId, pending } = consumed;

  // Mark the address confirmed so GoTrue will accept sign-in for it.
  await adminUpdateUser(gotrueUserId, { email_confirm: true });

  const admin = adminPool();
  const client = await admin.connect();
  let companyId = '';
  let paygEligible = false;
  try {
    await client.query('BEGIN');
    const provisioned = await provisionTenant(client, {
      ownerUserId: gotrueUserId,
      email: pending.email,
      firstName: pending.firstName,
      lastName: pending.lastName,
      companyName: pending.companyName,
      phone: pending.phone,
      annualTurnoverCents: pending.annualTurnoverCents,
      signupType: pending.signupType,
    });
    companyId = provisioned.companyId;
    paygEligible = provisioned.paygEligible;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) =>
      log.error(
        'ROLLBACK failed after provisioning error',
        { error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr) },
        'auth',
      ),
    );
    log.error('tenant provisioning failed after verification', {
      userId: gotrueUserId,
      error: err instanceof Error ? err.message : String(err),
    }, 'auth');
    throw err;
  } finally {
    client.release();
    await admin.end();
  }

  log.info('signup verified and provisioned', {
    companyId,
    paygEligible,
    signupType: pending.signupType,
  }, 'auth');

  // Fire-and-forget ops notification. Only reachable for a verified address, so
  // this cannot be used to flood the ops inbox with junk signups.
  sendEmail({
    to: NOTIFY_TO,
    subject: `ISAFlow signup: ${pending.email}`,
    html:
      `<p>New verified self-serve signup.</p>` +
      `<ul>` +
      `<li><strong>Email:</strong> ${escapeHtml(pending.email)}</li>` +
      `<li><strong>Company:</strong> ${escapeHtml(pending.companyName)}</li>` +
      `<li><strong>Type:</strong> ${pending.signupType}</li>` +
      `<li><strong>Company ID:</strong> ${companyId}</li>` +
      `</ul>`,
    // companyId null: internal ops mail. Logging it against the new tenant would
    // surface it inside their own Customer Communication report, which filters
    // email_log by company_id.
    _log: { companyId: null, emailType: 'other', sentBy: null },
  }).catch((err: unknown) => {
    log.error('signup notification email failed', {
      error: err instanceof Error ? err.message : String(err),
      companyId,
    }, 'auth');
  });

  // Deliberately NOT signed in: the link is often opened on a different device
  // from the one that signed up, and the only way to auto-sign-in here would be
  // to stash the password client-side. The page sends them to /login instead.
  return res.status(200).json({ success: true, data: { companyId } });
};

export default withRateLimit(handler, { max: 20, windowSecs: 3600 });
