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
import type { SignupType } from '@/modules/onboarding/services/tenantProvisioningService';

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

export interface ConsumedVerification {
  gotrueUserId: string;
  pending: PendingSignup;
}

/**
 * Atomically consume a verification token, returning the parked signup details.
 *
 * The UPDATE ... WHERE consumed_at IS NULL RETURNING is the concurrency guard:
 * two simultaneous clicks on the same link both match the row, but only one
 * UPDATE wins and returns a row — so a double-click can never provision two
 * tenants for one signup.
 *
 * Returns null when the token is unknown, already consumed, or expired. The
 * caller must not distinguish these cases to the user.
 */
export async function consumeEmailVerificationToken(
  rawToken: string,
): Promise<ConsumedVerification | null> {
  const tokenHash = hashToken(rawToken);

  const rows = (await sql`
    UPDATE auth_email_verification_tokens
    SET consumed_at = now()
    WHERE token_hash = ${tokenHash}
      AND consumed_at IS NULL
      AND expires_at > now()
    RETURNING gotrue_user_id, payload
  `) as Array<{ gotrue_user_id: string; payload: PendingSignup }>;

  const row = rows[0];
  if (!row) {
    log.info('email verification token rejected (unknown, used, or expired)', {}, 'auth');
    return null;
  }

  return { gotrueUserId: row.gotrue_user_id, pending: row.payload };
}

/**
 * Delete expired, unconsumed tokens. Unverified signups are abandoned far more
 * often than completed ones, so without a sweep this table grows unbounded on
 * an open registration endpoint. Returns the number of rows removed.
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
