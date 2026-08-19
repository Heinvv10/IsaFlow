/**
 * Email Verification Service
 *
 * Self-owned, single-use email-verification tokens for public self-serve signup.
 *
 * Public registration is open, so an unverified address must not be able to
 * create anything durable. Signup therefore creates the GoTrue user UNCONFIRMED
 * (GoTrue refuses sign-in with `email_not_confirmed`, verified empirically) and
 * parks the pending company details here. The tenant is provisioned only when
 * the emailed link is consumed — so junk signups cost one row and one email,
 * never a company, a subscription, or an ops notification.
 *
 * The raw token never leaves this process except in the emailed link: only
 * sha256(token) is persisted, so a read of the table cannot be replayed to
 * activate someone's account. Mirrors passwordResetService (migration 491).
 */

import crypto from 'crypto';
import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  QueryRunner,
  SignupType,
} from '@/modules/onboarding/services/tenantProvisioningService';

const VERIFICATION_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Pending tenant details captured at signup. Never contains credentials. */
export interface PendingSignup {
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string;
  phone: string | null;
  annualTurnoverCents: number | null;
  signupType: SignupType;
}

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Mint a single-use verification token for a GoTrue user. Invalidates any prior
 * unconsumed tokens for that user in the same transaction, so only the most
 * recent link is ever live — a resent email silently kills the older one.
 * Returns the RAW token (for the email link); the caller must never persist it.
 */
export async function createEmailVerificationToken(
  userId: string,
  pending: PendingSignup,
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('hex'); // 256-bit
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_MS);

  await withTransaction(async (tx) => {
    await tx`
      UPDATE auth_email_verification_tokens
      SET consumed_at = now()
      WHERE gotrue_user_id = ${userId}::uuid
        AND consumed_at IS NULL
        AND expires_at > now()
    `;
    await tx`
      INSERT INTO auth_email_verification_tokens
        (gotrue_user_id, token_hash, payload, expires_at)
      VALUES (
        ${userId}::uuid,
        ${tokenHash},
        ${JSON.stringify(pending)}::jsonb,
        ${expiresAt.toISOString()}::timestamptz
      )
    `;
  });

  return { token, expiresAt };
}

/**
 * Invalidate every live token belonging to a user.
 *
 * Needed when registration discards an unconfirmed leftover: deleting the
 * GoTrue user does NOT touch its token rows, and `company_users.user_id` has no
 * foreign key, so a stale link would still consume successfully and provision a
 * tenant owned by a user that no longer exists.
 */
export async function invalidateVerificationTokensForUser(userId: string): Promise<number> {
  const rows = (await sql`
    UPDATE auth_email_verification_tokens
       SET consumed_at = now()
     WHERE gotrue_user_id = ${userId}::uuid
       AND consumed_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length;
}

export interface ConsumedVerification {
  gotrueUserId: string;
  pending: PendingSignup;
}

/**
 * Atomically consume a verification token, returning the parked signup details.
 *
 * Runs on a caller-supplied client so it can share the SAME transaction as
 * tenant provisioning. That is the point: if provisioning fails afterwards, the
 * consumption rolls back with it and the emailed link still works. Consuming on
 * a separate connection would burn the token on a failed attempt and strand the
 * signup with no way to retry.
 *
 * The UPDATE ... WHERE consumed_at IS NULL RETURNING is the concurrency guard:
 * two simultaneous clicks both match the row, but only one UPDATE wins and
 * returns a row, so a double-click can never provision two tenants.
 *
 * Returns null when the token is unknown, already consumed, or expired. The
 * caller must not distinguish these cases to the user.
 */
export async function consumeEmailVerificationToken(
  client: QueryRunner,
  rawToken: string,
): Promise<ConsumedVerification | null> {
  const tokenHash = hashToken(rawToken);

  const { rows } = await client.query<{ gotrue_user_id: string; payload: PendingSignup }>(
    `UPDATE auth_email_verification_tokens
        SET consumed_at = now()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING gotrue_user_id, payload`,
    [tokenHash],
  );

  const row = rows[0];
  if (!row) {
    log.info('email verification token rejected (unknown, used, or expired)', {}, 'auth');
    return null;
  }

  return { gotrueUserId: row.gotrue_user_id, pending: row.payload };
}

/**
 * Look up an ALREADY-CONSUMED token without changing it.
 *
 * Verification finishes with a GoTrue call that sits outside the database
 * transaction, so it can fail after the tenant is committed. Re-opening the same
 * link must then be able to finish the job rather than report a dead link — this
 * is how the endpoint recovers, by recognising "already consumed, tenant exists"
 * as success instead of failure.
 */
export async function findConsumedVerification(
  rawToken: string,
): Promise<ConsumedVerification | null> {
  const rows = (await sql`
    SELECT gotrue_user_id, payload
      FROM auth_email_verification_tokens
     WHERE token_hash = ${hashToken(rawToken)}
       AND consumed_at IS NOT NULL
     LIMIT 1
  `) as Array<{ gotrue_user_id: string; payload: PendingSignup }>;

  const row = rows[0];
  return row ? { gotrueUserId: row.gotrue_user_id, pending: row.payload } : null;
}

/**
 * Delete expired, unconsumed tokens. Unverified signups are abandoned far more
 * often than completed ones, so without a sweep this table grows unbounded on
 * an open registration endpoint.
 *
 * Token rows ONLY. An earlier version also reported the GoTrue users behind
 * them for deletion, which was unsafe: "abandoned" was computed when the DELETE
 * ran, but the deletes happened afterwards, so a signup that verified in the gap
 * had its login destroyed underneath a freshly provisioned company. Leaving the
 * unconfirmed user in place costs nothing — it cannot sign in, and registering
 * the address again discards it (see /api/auth/register).
 */
export async function purgeExpiredVerificationTokens(): Promise<number> {
  const rows = (await sql`
    DELETE FROM auth_email_verification_tokens
     WHERE consumed_at IS NULL
       AND expires_at < now()
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length;
}
