/**
 * Admin User Actions Service
 * Suspend, activate, delete, password reset, session management,
 * company membership, and onboarding reset.
 * All mutations should be followed by logAdminAction from auditService.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { generateRandomPassword, hashPassword } from '@/lib/auth';

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
 * Generate a temporary password, hash and store it, return plain text.
 * Caller is responsible for emailing the reset token/password.
 */
export async function resetPassword(userId: string): Promise<string> {
  const temporaryPassword = generateRandomPassword();
  const hashed = await hashPassword(temporaryPassword);

  await sql`
    UPDATE users
    SET password_hash        = ${hashed},
        must_change_password = true,
        updated_at           = NOW()
    WHERE id = ${userId}
  `;

  log.info('resetPassword — temporary password issued', { userId }, 'AdminUserActionsService');
  return temporaryPassword;
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
