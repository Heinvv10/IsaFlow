/**
 * Admin User Actions Service
 * Suspend, activate, delete, password reset, session management,
 * company membership, and onboarding reset.
 * All mutations should be followed by logAdminAction from auditService.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { generateLink } from '@/lib/auth/gotrue-admin-link';
import { adminRevokeAllUserSessions } from '@/lib/auth/gotrue';

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
 * Initiate a password reset for a user via GoTrue's generate_link(recovery) API.
 * GoTrue sends the recovery email directly; no password_reset_tokens row needed.
 */
export async function resetPassword(userId: string): Promise<{ reset_link: string }> {
  type UserRow = { id: string; email: string; role: string };
  const rows = await sql<UserRow>`
    SELECT id, email, role FROM users WHERE id = ${userId} LIMIT 1
  `;
  const target = rows[0];
  if (!target) throw new Error(`User ${userId} not found`);
  if (target.role === 'super_admin') throw new Error('CANNOT_RESET_SUPER_ADMIN');

  const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za'}/reset-password`;
  const { action_link } = await generateLink('recovery', target.email, redirectTo);

  log.info('resetPassword — GoTrue recovery link generated', { userId }, 'AdminUserActionsService');
  return { reset_link: action_link };
}

/**
 * Force logout a user. Deleting rows from the app-level `user_sessions` table is
 * NOT enough: GoTrue access/refresh tokens are stateless HS256 JWTs, so the
 * target keeps refreshing via /api/auth/refresh until GoTrue itself revokes the
 * refresh tokens. We revoke those FIRST (fail-closed — if GoTrue can't revoke,
 * this throws and the app sessions are left intact so the admin sees a real
 * failure instead of a false "logged out"), THEN clear the app sessions.
 */
export async function forceLogout(userId: string): Promise<void> {
  await adminRevokeAllUserSessions(userId);
  await sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;
  log.info('forceLogout — GoTrue tokens revoked + app sessions cleared', { userId }, 'AdminUserActionsService');
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
