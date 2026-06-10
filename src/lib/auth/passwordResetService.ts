/**
 * Password Reset Service
 *
 * Self-owned, single-use password-reset tokens — the replacement for GoTrue's
 * /recover flow. GoTrue cannot distinguish a recovery session from a
 * magiclink/impersonation session (both surface as amr:otp and verify
 * interchangeably), so a GoTrue credential is too broad to gate a password
 * change. These tokens are minted ONLY by /api/auth/forgot-password and
 * consumed ONLY by /api/auth/do-reset-password.
 *
 * The raw token never leaves this process except in the emailed link: only
 * sha256(token) is persisted, so a read of auth_password_reset_tokens cannot be
 * replayed to reset an account. No email/PII is stored — the row is keyed by
 * the GoTrue user id alone.
 */

import crypto from 'crypto';
import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';

const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Mint a single-use reset token for a GoTrue user. Invalidates any prior
 * unconsumed tokens for that user (in the same transaction) so only the most
 * recent link is ever live. Returns the RAW token (for the email link) — the
 * caller must never persist it.
 */
export async function createPasswordResetToken(
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('hex'); // 256-bit
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);

  // Atomic: either both the invalidation and the new token land, or neither —
  // never a window where an old token survives alongside a freshly issued one.
  await withTransaction(async (tx) => {
    await tx`
      UPDATE auth_password_reset_tokens
      SET consumed_at = now()
      WHERE user_id = ${userId}::uuid
        AND consumed_at IS NULL
        AND expires_at > now()
    `;
    await tx`
      INSERT INTO auth_password_reset_tokens (user_id, token_hash, expires_at)
      VALUES (${userId}::uuid, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz)
    `;
  });

  log.info('Password reset token created', { userId }, 'passwordResetService');
  return { token, expiresAt };
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
