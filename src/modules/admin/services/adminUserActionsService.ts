/**
 * Admin User Actions Service
 * Suspend, activate, delete, password reset, session management,
 * company membership, and onboarding reset.
 * All mutations should be followed by logAdminAction from auditService.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { generateResetToken } from '@/lib/auth';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { passwordResetEmailHtml } from '@/lib/email-templates-auth';

type Row = DbRow;

export async function suspendUser(userId: string, reason: string): Promise<void> {
  await sql`
    UPDATE users
    SET is_active        = false,
        suspended_reason = ${reason},
        suspended_at     = NOW(),
        updated_at       = NOW()
    WHERE id = ${userId}
  `;
  await sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;
  log.info('suspendUser', { userId, reason }, 'AdminUserActionsService');
}

export async function activateUser(userId: string): Promise<void> {
  await sql`
    UPDATE users
    SET is_active        = true,
        suspended_reason = NULL,
        suspended_at     = NULL,
        updated_at       = NOW()
    WHERE id = ${userId}
  `;
  log.info('activateUser', { userId }, 'AdminUserActionsService');
}

/**
 * Send a password reset email to the user.
 * Generates a secure token, stores it, and emails the reset link.
 */
export async function resetPassword(userId: string): Promise<void> {
  const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.isaflow.co.za';

  const rows = (await sql`
    SELECT id, email, first_name FROM users WHERE id = ${userId} LIMIT 1
  `) as Array<{ id: string; email: string; first_name: string }>;

  if (rows.length === 0) throw new Error(`User ${userId} not found`);
  const user = rows[0]!;

  // Invalidate any existing unused tokens
  await sql`
    UPDATE password_reset_tokens
    SET used_at = NOW()
    WHERE user_id = ${userId} AND used_at IS NULL
  `;

  const { token, hashedToken, expiresAt } = generateResetToken();

  await sql`
    INSERT INTO password_reset_tokens (user_id, hashed_token, expires_at)
    VALUES (${userId}, ${hashedToken}, ${expiresAt.toISOString()}::TIMESTAMPTZ)
  `;

  const resetUrl = `${APP_URL}/reset-password?token=${token}`;

  const result = await sendEmail({
    to: user.email,
    subject: 'Reset your ISAFlow password',
    html: passwordResetEmailHtml({ name: user.first_name, resetUrl }),
  });

  if (!result.success) {
    throw new Error(`Failed to send reset email: ${result.error}`);
  }

  log.info('resetPassword — reset email sent by admin', { userId }, 'AdminUserActionsService');
}

/** Force logout by deleting all active sessions for a user. */
export async function forceLogout(userId: string): Promise<void> {
  await sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;
  log.info('forceLogout — sessions cleared', { userId }, 'AdminUserActionsService');
}

const ALLOWED_COMPANY_ROLES = ['admin', 'accountant', 'bookkeeper', 'viewer'];

export async function addUserToCompany(
  userId: string,
  companyId: string,
  role: string,
): Promise<void> {
  if (role && !ALLOWED_COMPANY_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
  await sql`
    INSERT INTO company_users (user_id, company_id, role, created_at)
    VALUES (${userId}, ${companyId}, ${role}, NOW())
    ON CONFLICT (user_id, company_id) DO UPDATE
      SET role = EXCLUDED.role
  `;
  log.info('addUserToCompany', { userId, companyId, role }, 'AdminUserActionsService');
}

export async function removeUserFromCompany(
  userId: string,
  companyId: string,
): Promise<void> {
  await sql`
    DELETE FROM company_users
    WHERE user_id = ${userId} AND company_id = ${companyId}
  `;
  log.info('removeUserFromCompany', { userId, companyId }, 'AdminUserActionsService');
}

/**
 * Permanently delete a user and all associated company links / sessions.
 * Super-admins are protected — throws if the target user has role = 'super_admin'.
 */
export async function deleteUser(userId: string): Promise<void> {
  const rows = await sql`
    SELECT role FROM users WHERE id = ${userId} LIMIT 1
  `;
  if (rows.length === 0) throw new Error(`User ${userId} not found`);
  if ((rows[0] as Row).role === 'super_admin') {
    throw new Error('Cannot delete a super_admin user');
  }

  await sql`DELETE FROM user_sessions   WHERE user_id = ${userId}`;
  await sql`DELETE FROM company_users   WHERE user_id = ${userId}`;
  await sql`DELETE FROM users           WHERE id      = ${userId}`;

  log.info('deleteUser', { userId }, 'AdminUserActionsService');
}

/**
 * Reset a user's onboarding state so they go through the company wizard again
 * on next login. Removes all company links and clears sessions.
 */
export async function resetOnboarding(userId: string): Promise<void> {
  await sql`
    UPDATE users
    SET onboarding_completed = false,
        updated_at           = NOW()
    WHERE id = ${userId}
  `;
  await sql`DELETE FROM company_users WHERE user_id = ${userId}`;
  await sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;
  log.info('resetOnboarding — user must re-onboard', { userId }, 'AdminUserActionsService');
}
