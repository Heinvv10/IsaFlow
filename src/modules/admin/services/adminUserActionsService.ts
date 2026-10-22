/**
 * Admin User Actions Service
 * Suspend, activate, delete, password reset, session management,
 * and onboarding reset. Linking, re-roling or removing one company membership:
 * companyMembershipService.ts.
 * All mutations should be followed by logAdminAction from auditService.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendPasswordResetEmail } from '@/lib/auth/passwordResetEmail';
import { adminRevokeAllUserSessions } from '@/lib/auth/gotrue';
import { revokeAllUserPats } from '@/lib/auth/personalAccessTokens';
import { revokeAllUserAuthorisations } from '@/lib/auth/oauth';

type Row = DbRow;

/**
 * Suspend a user and revoke every credential they hold.
 *
 * Order matters. The `is_active`/`suspended_at` flag is written FIRST because
 * it is the durable gate: withAuth, bearerPipeline, withUserAuth and
 * /api/auth/login all refuse a user who fails it (see
 * `src/lib/auth/userAccountStatus.ts`). Once that row is written the account is
 * closed even if every revocation below fails.
 *
 * Revocation is belt-and-braces on top of that gate — a revoked-at-source
 * credential cannot be replayed by some future code path that forgets to
 * consult the gate:
 *   - GoTrue refresh tokens, so a live browser session dies now instead of at
 *     token expiry (access tokens are stateless HS256 JWTs; GoTrue is the only
 *     thing that can stop the refresh loop);
 *   - PATs and OAuth authorisations, which suspension previously ignored
 *     entirely — an ex-employee's MCP token kept writing to the ledger.
 *
 * `DELETE FROM user_sessions` is retained for hygiene only. That table has had
 * NO writer anywhere in the codebase since the GoTrue cutover (every remaining
 * reference is a read for admin dashboards or a delete); prod's newest row is
 * from 2026-04-18 and none are unexpired. It is NOT session revocation — do
 * not mistake it for one.
 *
 * Throws if GoTrue revocation fails. The suspension itself has already landed
 * and is enforced; the throw exists so the admin learns that pre-existing
 * browser sessions may survive until their token expires, rather than seeing a
 * silent success.
 */
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

  // DB-side revocations first: same database as the flag, so these are the
  // ones that reliably land. GoTrue is a network hop and may be down.
  const pats = await revokeAllUserPats(userId);
  const authorisations = await revokeAllUserAuthorisations(userId);

  try {
    await adminRevokeAllUserSessions(userId);
  } catch (err) {
    log.error('suspendUser — user suspended but GoTrue session revocation failed', {
      userId,
      pats,
      authorisations,
      message: err instanceof Error ? err.message : String(err),
    }, 'AdminUserActionsService');
    throw new Error(
      'User suspended and API tokens revoked, but existing browser sessions could not be revoked — ' +
      'they will expire on their own. Retry Force Logout once GoTrue is reachable.',
    );
  }

  log.info('suspendUser', { userId, reason, pats, authorisations }, 'AdminUserActionsService');
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
 * Email a user our self-owned, single-use reset link (the forgot-password flow).
 * Returns nothing a caller could hand on: the link exists only in the email.
 * Throws PasswordResetEmailNotSentError when the email could not be sent.
 */
export async function resetPassword(userId: string): Promise<void> {
  type UserRow = { id: string; email: string; role: string };
  const rows = await sql<UserRow>`
    SELECT id, email, role FROM users WHERE id = ${userId} LIMIT 1
  `;
  const target = rows[0];
  if (!target) throw new Error(`User ${userId} not found`);
  if (target.role === 'super_admin') throw new Error('CANNOT_RESET_SUPER_ADMIN');

  await sendPasswordResetEmail(target.id, target.email);
  log.info('resetPassword — reset email sent', { userId }, 'AdminUserActionsService');
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

/** The roles the admin portal may grant (never `owner`; migration 883 refuses it too). */
export const ALLOWED_COMPANY_ROLES = ['admin', 'accountant', 'bookkeeper', 'viewer'];

/** The refusal for removing or demoting a company's last owner (the admin site shows it). */
export const ONLY_OWNER_MESSAGE = "This user is the company's only owner. Make someone else owner first.";

/** Migration 908b's trigger refusal (RC011): no writer but app_user removes or demotes a last owner. */
export const isOnlyOwnerRefusal = (err: unknown): boolean => (err as { code?: string } | null)?.code === 'RC011';

/**
 * Deleting a user, or resetting their onboarding, removes them from every
 * company; refused whole when they are the only owner of any. Raised before
 * anything is written, or from the trigger's RC011 (which aborts the request
 * transaction, so nothing it wrote commits).
 */
export class SoleOwnerError extends Error {
  constructor(public readonly companies: readonly string[]) {
    super(companies.length > 0
      ? `This user is the only owner of ${companies.join(', ')}. Make someone else owner first.`
      : ONLY_OWNER_MESSAGE);
    this.name = 'SoleOwnerError';
  }
}

/** Throws SoleOwnerError naming each company `userId` is the only owner of (counted as migration 908b counts). */
async function assertOwnsNoCompanyAlone(userId: string): Promise<void> {
  const rows = await sql<{ name: string }>`
    SELECT DISTINCT c.name FROM company_users cu
    JOIN companies c ON c.id = cu.company_id
    WHERE cu.user_id = ${userId} AND cu.role = 'owner'
      AND NOT EXISTS (
        SELECT 1 FROM company_users o
        WHERE o.company_id = cu.company_id AND o.role = 'owner'
          AND lower(o.user_id::text) <> lower(${userId})
      )
    ORDER BY c.name
  `;
  if (rows.length > 0) throw new SoleOwnerError(rows.map((r) => r.name));
}

/** Remove `userId` from every company, or throw SoleOwnerError (see above). Runs before any other write. */
async function removeFromEveryCompany(userId: string): Promise<void> {
  await assertOwnsNoCompanyAlone(userId);
  try {
    await sql`DELETE FROM company_users WHERE user_id = ${userId}`;
  } catch (err) {
    if (isOnlyOwnerRefusal(err)) throw new SoleOwnerError([]);
    throw err;
  }
}

/**
 * Permanently delete a user and all associated company links / sessions.
 * Super-admins are protected — throws if the target user has role = 'super_admin'.
 * Throws SoleOwnerError, having written nothing, when the user is a company's only owner.
 */
export async function deleteUser(userId: string): Promise<void> {
  const rows = await sql`
    SELECT role FROM users WHERE id = ${userId} LIMIT 1
  `;
  if (rows.length === 0) throw new Error(`User ${userId} not found`);
  if ((rows[0] as Row).role === 'super_admin') {
    throw new Error('Cannot delete a super_admin user');
  }

  await removeFromEveryCompany(userId);
  await sql`DELETE FROM user_sessions   WHERE user_id = ${userId}`;
  await sql`DELETE FROM users           WHERE id      = ${userId}`;

  log.info('deleteUser', { userId }, 'AdminUserActionsService');
}

/**
 * Reset a user's onboarding state so they go through the company wizard again
 * on next login. Removes all company links and clears sessions. Throws
 * SoleOwnerError, having written nothing, when the user is a company's only owner.
 */
export async function resetOnboarding(userId: string): Promise<void> {
  await removeFromEveryCompany(userId);
  await sql`
    UPDATE users
    SET onboarding_completed = false,
        updated_at           = NOW()
    WHERE id = ${userId}
  `;
  await sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;
  log.info('resetOnboarding — user must re-onboard', { userId }, 'AdminUserActionsService');
}
