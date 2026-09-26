/**
 * Password Reset Service
 *
 * Self-owned, single-use password-reset tokens — the replacement for GoTrue's
 * /recover flow. GoTrue cannot distinguish a recovery session from a
 * magiclink/impersonation session (both surface as amr:otp and verify
 * interchangeably), so a GoTrue credential is too broad to gate a password
 * change. These tokens are minted ONLY through passwordResetEmail.ts (by
 * /api/auth/forgot-password and the admin "Reset password" action) and
 * consumed ONLY by /api/auth/do-reset-password.
 *
 * The raw token never leaves this process except in the emailed link: only
 * sha256(token) is persisted, so a read of auth_password_reset_tokens cannot be
 * replayed to reset an account. No email/PII is stored — the row is keyed by
 * the GoTrue user id alone.
 */

import crypto from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Mint a single-use reset token for a GoTrue user. Prior unconsumed tokens stay
 * live until `supersedePasswordResetTokens` runs after the new link is
 * delivered — a send that fails must not kill the link the user already has.
 * Returns the RAW token (for the email link) — the caller must never persist
 * it — and its hash, which is what the follow-up calls name it by.
 */
export async function issuePasswordResetToken(
  userId: string,
): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('hex'); // 256-bit
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);
  await sql`
    INSERT INTO auth_password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (${userId}::uuid, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz)
  `;
  log.info('Password reset token created', { userId }, 'passwordResetService');
  return { token, tokenHash, expiresAt };
}

/**
 * The new link was delivered: retire the user's unconsumed tokens issued
 * BEFORE it. Only older ones — two interleaved resets (a detached
 * forgot-password beside an admin reset, a double click) each supersede after
 * their own send, and retiring "every other" token let the run that finished
 * last kill the NEWER link too, leaving the user none. A created_at tie is
 * broken by id, so of two tied tokens exactly one survives.
 */
export async function supersedePasswordResetTokens(userId: string, keepTokenHash: string): Promise<void> {
  await sql`
    UPDATE auth_password_reset_tokens t
    SET consumed_at = now()
    FROM auth_password_reset_tokens k
    WHERE k.token_hash = ${keepTokenHash}
      AND k.user_id = ${userId}::uuid
      AND t.user_id = k.user_id
      AND (t.created_at, t.id) < (k.created_at, k.id)
      AND t.consumed_at IS NULL
      AND t.expires_at > now()
  `;
}

/** The link never went out: retire just this token. */
export async function withdrawPasswordResetToken(tokenHash: string): Promise<void> {
  await sql`
    UPDATE auth_password_reset_tokens SET consumed_at = now()
    WHERE token_hash = ${tokenHash} AND consumed_at IS NULL
  `;
}

/**
 * Atomically consume a reset token. Returns the owning user id, or null if the
 * token is unknown, expired, or already consumed (incl. a concurrent race).
 * Throws only on an actual DB failure — the caller must treat a throw as a 5xx,
 * not as an invalid token.
 */
export async function consumePasswordResetToken(
  rawToken: string,
): Promise<{ userId: string } | null> {
  const tokenHash = hashToken(rawToken);

  const rows = (await sql`
    SELECT id, user_id
    FROM auth_password_reset_tokens
    WHERE token_hash = ${tokenHash}
      AND consumed_at IS NULL
      AND expires_at > now()
    LIMIT 1
  `) as Record<string, unknown>[];

  if (rows.length === 0) return null;
  const row = rows[0] as { id: string; user_id: string };

  // Atomic single-use guard: only the request that flips consumed_at wins.
  const updated = (await sql`
    UPDATE auth_password_reset_tokens
    SET consumed_at = now()
    WHERE id = ${row.id}::uuid AND consumed_at IS NULL
    RETURNING id
  `) as Record<string, unknown>[];

  if (updated.length === 0) {
    log.warn('Password reset token consumed by concurrent request', { tokenId: row.id }, 'passwordResetService');
    return null;
  }

  log.info('Password reset token consumed', { userId: row.user_id }, 'passwordResetService');
  return { userId: String(row.user_id) };
}

/** Housekeeping: drop tokens that expired more than 7 days ago. */
export async function cleanupExpiredResetTokens(): Promise<void> {
  await sql`
    DELETE FROM auth_password_reset_tokens
    WHERE expires_at < now() - INTERVAL '7 days'
  `;
}
