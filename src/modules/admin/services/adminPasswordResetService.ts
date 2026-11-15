/**
 * Admin password reset (admin audit 2026-11-14 F-11; review #1407): the refusal look-up a route answers before any
 * audit row, token or email, and the reset itself. Re-exported by adminUserActionsService.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendPasswordResetEmail } from '@/lib/auth/passwordResetEmail';

/** Why an admin may not reset this user's password, or null when they may (F-11: checked before anything is written). */
export type ResetPasswordRefusal = 'not_found' | 'super_admin';

/** The refusal, or the user's real id (users.id as stored) when an admin may reset their password. */
export type ResetPasswordTarget =
  | { refusal: ResetPasswordRefusal; userId: null }
  | { refusal: null; userId: string };

/**
 * users.id is TEXT holding a UUID: the id is matched case-insensitively (review #1407), so an upper-cased id is the
 * same user, and the caller gets the stored id back to reset and audit by (never the spelling in the URL). This is
 * the ONE place the id is resolved: an exact match wins over a case variant (two rows differing only in case are
 * possible on TEXT), and resetPassword then takes that exact id (breaker #1405 round 5).
 */
export async function resetPasswordRefusal(userId: string): Promise<ResetPasswordTarget> {
  const rows = await sql<{ id: string; role: string }>`
    SELECT id, role FROM users WHERE lower(id) = lower(${userId})
    ORDER BY (id = ${userId}) DESC, id
    LIMIT 1
  `;
  if (!rows[0]) return { refusal: 'not_found', userId: null };
  if (rows[0].role === 'super_admin') return { refusal: 'super_admin', userId: null };
  return { refusal: null, userId: String(rows[0].id) };
}

/**
 * Email a user our self-owned, single-use reset link (the forgot-password flow).
 * `userId` is the stored id resetPasswordRefusal resolved, matched exactly: the refusal and the send are about the
 * same row. Returns nothing a caller could hand on: the link exists only in the email.
 * Throws PasswordResetEmailNotSentError when the email could not be sent.
 */
export async function resetPassword(userId: string): Promise<void> {
  type UserRow = { id: string; email: string; role: string };
  const rows = await sql<UserRow>`
    SELECT id, email, role FROM users WHERE id = ${userId}
  `;
  const target = rows[0];
  if (!target) throw new Error(`User ${userId} not found`);
  if (target.role === 'super_admin') throw new Error('CANNOT_RESET_SUPER_ADMIN');

  await sendPasswordResetEmail(target.id, target.email);
  log.info('resetPassword — reset email sent', { userId }, 'AdminUserActionsService');
}
