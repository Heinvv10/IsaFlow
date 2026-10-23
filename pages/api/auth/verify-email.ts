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
import type { NextApiHandler, NextApiResponse } from 'next';
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool
// in this process. This file builds its own Pool, so it must not depend on
// src/lib/neon.ts having been imported first. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import { adminUpdateUser, type GoTrueUser } from '@/lib/auth/gotrue';
import { adminGetUser } from '@/lib/auth/gotrueAdminUser';
import { AuthUpstreamUnavailableError } from '@/lib/auth/authUpstream';
import {
  consumeEmailVerificationToken,
  findConsumedVerification,
} from '@/lib/auth/emailVerificationService';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { provisionTenant } from '@/modules/onboarding/services/tenantProvisioningService';
import { sql } from '@/lib/neon';
import { withRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';

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
  const pool = new pg.Pool({
    connectionString: url,
    max: 2,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  // Built per request and ended by it, but inside the server process: an unlistened pool error
  // there is an uncaught exception (R-176).
  pool.on('error', (err) => log.warn('verify-email pool error', { message: err.message }, 'auth'));
  return pool;
}

/**
 * Recover a signup whose token was consumed and tenant committed, but whose
 * final GoTrue confirmation did not land. Returns null for a genuinely dead
 * link — a consumed token with no tenant behind it is not recoverable here.
 *
 * Tradeoff: re-opening an already-used link now answers 200 with the company id
 * instead of 410, so whoever holds the link learns that id. Accepted — it is an
 * opaque UUID, the holder already had the link, and the alternative is stranding
 * every signup whose confirmation call failed. Provisioning stays single-use
 * regardless: the atomic consume in the transaction is what guarantees that, not
 * this lookup.
 */
async function recoverAlreadyConsumed(
  token: string,
): Promise<{ gotrueUserId: string; companyId: string } | null> {
  const consumed = await findConsumedVerification(token);
  if (!consumed) return null;

  const rows = (await sql`
    SELECT company_id
      FROM company_users
     WHERE user_id = ${consumed.gotrueUserId}
       AND role = 'owner'
     ORDER BY created_at ASC
     LIMIT 1
  `) as Array<{ company_id: string }>;

  const companyId = rows[0]?.company_id;
  return companyId ? { gotrueUserId: consumed.gotrueUserId, companyId } : null;
}

const INVALID_TOKEN = {
  success: false,
  error: {
    code: 'INVALID_OR_EXPIRED',
    message: 'This confirmation link is invalid, expired, or already used.',
  },
} as const;

const EMAIL_MISMATCH = {
  success: false,
  error: {
    code: 'EMAIL_MISMATCH',
    message: 'This confirmation link does not match the account it was issued for. Please sign up again.',
  },
} as const;

const CONFIRMATION_INCOMPLETE = {
  success: false,
  error: {
    code: 'CONFIRMATION_INCOMPLETE',
    message: 'Your account was created but we could not finish confirming it. Please open the link from your email again.',
  },
} as const;

/**
 * Confirm the address in GoTrue on a path where the token is already spent and
 * the tenant committed. A GoTrue OUTAGE answers 503 CONFIRMATION_INCOMPLETE
 * (D9): opening the same link again reaches the consumed-token recovery and
 * finishes this. Returns false once it has answered; any other failure throws.
 */
async function confirmOrAskToRetry(res: NextApiResponse, gotrueUserId: string): Promise<boolean> {
  try {
    await adminUpdateUser(gotrueUserId, { email_confirm: true });
    return true;
  } catch (err) {
    if (!(err instanceof AuthUpstreamUnavailableError)) throw err;
    log.warn('email confirmation hit an auth outage — the link will finish it', { message: err.message }, 'auth');
    res.status(503).json(CONFIRMATION_INCOMPLETE);
    return false;
  }
}

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
  }

  const { token } = req.body ?? {};
  // Tokens are 32 random bytes rendered as hex — anything else is not one.
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    return res.status(400).json(INVALID_TOKEN);
  }

  const admin = adminPool();
  const client = await admin.connect();
  let companyId = '';
  let paygEligible = false;
  let gotrueUserId = '';
  let email = '';
  let companyName = '';
  let signupType = '';
  let unusable = false;

  try {
    // Consumption and provisioning share ONE transaction. If provisioning
    // throws, the consumption rolls back with it and the emailed link still
    // works — burning the token on a failed attempt would strand the signup
    // with no company and no way to retry.
    await client.query('BEGIN');
    const consumed = await consumeEmailVerificationToken(client, token);

    if (!consumed) {
      unusable = await rollbackFailed(client, 'verify-email');
      // Either a dead link, or a retry after the post-commit GoTrue call below
      // failed. Distinguish by whether the tenant actually exists.
      const recovered = await recoverAlreadyConsumed(token);
      if (recovered) {
        if (!(await confirmOrAskToRetry(res, recovered.gotrueUserId))) return;
        log.info('verification retry completed a partially-finished signup', {
          companyId: recovered.companyId,
        }, 'auth');
        return res.status(200).json({ success: true, data: { companyId: recovered.companyId } });
      }
      return res.status(410).json(INVALID_TOKEN);
    }

    gotrueUserId = consumed.gotrueUserId;
    email = consumed.pending.email;

    // The token's payload email becomes users.email and the tenant's contact
    // address; provision only for the address GoTrue holds for this user, so a
    // planted or stale payload cannot claim someone else's (S-07c C4). A
    // refusal or an outage rolls the consumption back: the link still works.
    let gotrueUser: GoTrueUser | null;
    try {
      gotrueUser = await adminGetUser(gotrueUserId);
    } catch (err) {
      if (!(err instanceof AuthUpstreamUnavailableError)) throw err;
      unusable = await rollbackFailed(client, 'verify-email');
      log.warn('verification hit an auth outage before provisioning — the link still works', { message: err.message }, 'auth');
      return res.status(503).json(CONFIRMATION_INCOMPLETE);
    }
    if (gotrueUser?.email?.trim().toLowerCase() !== email.trim().toLowerCase()) {
      unusable = await rollbackFailed(client, 'verify-email');
      log.error('verification refused: token email is not the GoTrue user\'s', { gotrueUserId, found: gotrueUser !== null }, 'auth');
      return res.status(409).json(EMAIL_MISMATCH);
    }
    companyName = consumed.pending.companyName;
    signupType = consumed.pending.signupType;

    // One tenant per user, enforced here rather than assumed from the token.
    // Two live tokens can exist for one GoTrue user: concurrent registrations of
    // the same new address both fall back to the same user (GoTrue 422 →
    // adminGetUserByEmail), and their token-invalidation UPDATEs can both run
    // before either INSERT, so neither invalidates the other. Provisioning off
    // the token alone would then hand that user a second company.
    const owned = await client.query<{ company_id: string }>(
      `SELECT company_id FROM company_users
        WHERE user_id = $1 AND role = 'owner'
        ORDER BY created_at ASC
        LIMIT 1`,
      [gotrueUserId],
    );
    if (owned.rows[0]) {
      await client.query('COMMIT');
      log.warn('verification skipped provisioning — user already owns a tenant', {
        companyId: owned.rows[0].company_id,
      }, 'auth');
      if (!(await confirmOrAskToRetry(res, gotrueUserId))) return;
      return res.status(200).json({ success: true, data: { companyId: owned.rows[0].company_id } });
    }

    const provisioned = await provisionTenant(client, {
      ownerUserId: gotrueUserId,
      email,
      firstName: consumed.pending.firstName,
      lastName: consumed.pending.lastName,
      companyName: consumed.pending.companyName,
      phone: consumed.pending.phone,
      annualTurnoverCents: consumed.pending.annualTurnoverCents,
      signupType: consumed.pending.signupType,
    });
    companyId = provisioned.companyId;
    paygEligible = provisioned.paygEligible;
    await client.query('COMMIT');
  } catch (err) {
    // Not again if the early ROLLBACK above already failed: that client is condemned, and a second
    // ROLLBACK would only queue behind the stuck one and send its backend a second cancel.
    if (!unusable) unusable = await rollbackFailed(client, 'verify-email');
    log.error('tenant provisioning failed after verification', {
      error: err instanceof Error ? err.message : String(err),
    }, 'auth');
    throw err;
  } finally {
    client.release(unusable); // R-176: a failed ROLLBACK leaves the transaction open; destroy it, do not pool it
    await admin.end();
  }

  // Confirm the address only once the tenant is committed. This is a GoTrue call
  // and cannot join the transaction, so it is the one step that can fail with
  // work already durable — hence the recovery path above: re-opening the link
  // finds the consumed token plus a real tenant and simply retries this.
  try {
    await adminUpdateUser(gotrueUserId, { email_confirm: true });
  } catch (err) {
    log.error('email confirmation failed after provisioning — user must retry the link', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    }, 'auth');
    return res.status(503).json(CONFIRMATION_INCOMPLETE);
  }

  log.info('signup verified and provisioned', { companyId, paygEligible }, 'auth');

  // Fire-and-forget ops notification. Only reachable for a verified address, so
  // this cannot be used to flood the ops inbox with junk signups.
  sendEmail({
    to: NOTIFY_TO,
    subject: `ISAFlow signup: ${email}`,
    html:
      `<p>New verified self-serve signup.</p>` +
      `<ul>` +
      `<li><strong>Email:</strong> ${escapeHtml(email)}</li>` +
      `<li><strong>Company:</strong> ${escapeHtml(companyName)}</li>` +
      `<li><strong>Type:</strong> ${signupType}</li>` +
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

export default withRateLimit(handler, { max: 20, windowSecs: 3600 }, 'verify-email');
