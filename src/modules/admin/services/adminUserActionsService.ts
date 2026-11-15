/**
 * Admin User Actions Service
 * Suspend, activate, delete, session management and onboarding reset (password reset: adminPasswordResetService.ts,
 * re-exported here). Linking, re-roling or removing one company membership:
 * companyMembershipService.ts.
 * All mutations should be followed by logAdminAction from auditService.
 */

import { sql } from '@/lib/neon';
import { AdminRequestError } from '@/modules/admin/middleware/adminRequestErrors';
import { log } from '@/lib/logger';
import { adminRevokeAllUserSessions } from '@/lib/auth/gotrue';
import { revokeAllUserPats } from '@/lib/auth/personalAccessTokens';
import { revokeAllUserAuthorisations } from '@/lib/auth/oauth';
import {
  assertPayRunApproverRetainedEverywhere, findStrandedPayRunRequests, type StrandedPayRunRequest,
} from '@/modules/accounting/services/core/payRunApproverGuard';

// Admin password reset lives in its own module (this one passed 300 lines); re-exported so callers keep one import.
export { resetPassword, resetPasswordRefusal, type ResetPasswordRefusal, type ResetPasswordTarget } from './adminPasswordResetService';

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
 * A failed GoTrue revocation does NOT throw (admin audit 2026-11-14, 3.2): the
 * suspension stands and commits with its audit row, because closing a
 * compromised account must not wait for GoTrue. `sessionsRevoked: false` tells
 * the route, which records `revocation_failed` on the audit row and tells the
 * admin that live browser sessions may survive until their token expires. Any
 * other failure throws, and the route lets it become a 5xx so withPlatformAdmin
 * rolls the suspension back: a suspension never commits without its audit row.
 *
 * Never refused for a pending pay-run approval (revoking a compromised account must always land). When the user is
 * the last other eligible approver of one, the suspension still goes ahead; the requests it strands are logged and
 * returned (the route puts them on the admin audit row). They cannot be self-approved by their requester: the
 * sole-approver fallback needs the roster unchanged since the request was raised (see payRunApproverGuard).
 */
export interface SuspendOutcome {
  stranded: StrandedPayRunRequest[];
  /** False when GoTrue could not revoke the browser sessions: they live until their tokens expire. */
  sessionsRevoked: boolean;
}

/** The admin's answer when the suspension landed but GoTrue could not revoke the browser sessions. */
export const SESSIONS_NOT_REVOKED_MESSAGE =
  'User suspended and API tokens revoked, but existing browser sessions could not be revoked — ' +
  'they will expire on their own. Retry Force Logout once GoTrue is reachable.';

export async function suspendUser(userId: string, reason: string): Promise<SuspendOutcome> {
  const stranded = await strandedOrNone(userId);
  await sql`
    UPDATE users
    SET is_active        = false,
        suspended_reason = ${reason},
        suspended_at     = NOW(),
        updated_at       = NOW()
    WHERE id = ${userId}
  `;
  reportStranded('suspendUser', userId, stranded);
  await sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;

  // DB-side revocations first: same database as the flag, so these are the
  // ones that reliably land. GoTrue is a network hop and may be down.
  const pats = await revokeAllUserPats(userId);
  const authorisations = await revokeAllUserAuthorisations(userId);

  let sessionsRevoked = true;
  try {
    await adminRevokeAllUserSessions(userId);
  } catch (err) {
    sessionsRevoked = false;
    log.error('suspendUser — user suspended but GoTrue session revocation failed', {
      userId,
      pats,
      authorisations,
      message: err instanceof Error ? err.message : String(err),
    }, 'AdminUserActionsService');
  }

  log.info('suspendUser', { userId, reason, pats, authorisations, sessionsRevoked }, 'AdminUserActionsService');
  return { stranded, sessionsRevoked };
}

/** The look-up must never stand between an admin and an emergency revocation: a failure is logged and nothing is reported. */
async function strandedOrNone(userId: string): Promise<StrandedPayRunRequest[]> {
  try {
    return await findStrandedPayRunRequests(userId);
  } catch (err) {
    log.error('could not look for pay-run approvals this revocation strands; revoking anyway',
      { userId, message: err instanceof Error ? err.message : String(err) }, 'AdminUserActionsService');
    return [];
  }
}

/** Pending pay-run approvals an emergency revocation left without another approver: a warning, never a refusal. */
function reportStranded(action: string, userId: string, stranded: StrandedPayRunRequest[]): void {
  if (stranded.length === 0) return;
  log.warn(`${action}: the user was the last other approver of a pending pay-run approval; their requester cannot self-approve it on the old roster`,
    { userId, stranded }, 'AdminUserActionsService');
}

/** False when no user has this id (nothing was updated). */
export async function activateUser(userId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE users
    SET is_active        = true,
        suspended_reason = NULL,
        suspended_at     = NULL,
        updated_at       = NOW()
    WHERE id = ${userId}
    RETURNING id
  `;
  if (rows.length === 0) return false;
  log.info('activateUser', { userId }, 'AdminUserActionsService');
  return true;
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
  // A missing user is a 404 before GoTrue is called and before the audit row (review #1405 round 3, D6). A plain
  // read: no row lock is held across the GoTrue call, and only user_sessions is written (LOCK ORDER below).
  const user = await sql`SELECT 1 FROM users WHERE id = ${userId}`;
  if (user.length === 0) throw new AdminRequestError(404, 'User not found');
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

/**
 * Remove `userId` from every company, or throw SoleOwnerError (see above). Runs before any other write.
 * `refuseStranding`: also refuse (PayRunApproverProtectedError) when that leaves a pending pay-run approval without
 * an approver but its requester. Not for a deletion, which is an emergency revocation too.
 */
async function removeFromEveryCompany(userId: string, refuseStranding: boolean): Promise<void> {
  await assertOwnsNoCompanyAlone(userId);
  if (refuseStranding) await assertPayRunApproverRetainedEverywhere(userId);
  await deleteMemberships(userId);
}

/** Every company_users row of `userId`; a last owner's row is the trigger's RC011, answered as SoleOwnerError. */
async function deleteMemberships(userId: string): Promise<void> {
  try {
    await sql`DELETE FROM company_users WHERE user_id = ${userId}`;
  } catch (err) {
    if (isOnlyOwnerRefusal(err)) throw new SoleOwnerError([]);
    throw err;
  }
}

/*
 * LOCK ORDER for a user's rows (review #1405 round 4): company_users, then users, then user_sessions, the order the
 * tenant invite-accept routes already use (they upsert the membership, then write the users row). deleteUser and
 * resetOnboarding take their company_users rows first and decide by the users statement's RETURNING; suspendUser,
 * activateUser and forceLogout write no company_users. A users-first writer deadlocked against invite accept and
 * reset-onboarding. Census of every writer: the admin .claude.md ("Lock order for a user's rows").
 */

/**
 * Permanently delete a user and all associated company links / sessions.
 * Super-admins are protected — throws if the target user has role = 'super_admin'.
 * Throws SoleOwnerError, having written nothing, when the user is a company's only owner.
 */
export async function deleteUser(userId: string): Promise<StrandedPayRunRequest[]> {
  const users = await sql<{ role: string }>`SELECT role FROM users WHERE id = ${userId}`;
  if (users.length === 0) throw new AdminRequestError(404, 'User not found');
  if (users[0]!.role === 'super_admin') {
    throw new AdminRequestError(403, 'Cannot delete a super_admin user');
  }

  // Never refused for a pending pay-run approval (see suspendUser): reported instead.
  const stranded = await strandedOrNone(userId);
  await removeFromEveryCompany(userId, false); // company_users first (LOCK ORDER above)
  // The DELETE decides: the loser of two concurrent deletes matches nothing and is a 404 before the route's audit row
  // (its company_users DELETE above matched nothing either). It also waits for an in-flight add-to-company, which
  // holds the users row FOR KEY SHARE (companyMembershipService.addUserToCompany).
  const deleted = await sql`DELETE FROM users WHERE id = ${userId} RETURNING id`;
  if (deleted.length === 0) throw new AdminRequestError(404, 'User not found');
  await sql`DELETE FROM user_sessions WHERE user_id = ${userId}`; // the FK cascade already did; hygiene
  // A membership an add-to-company committed while this request waited above would outlive the user (breaker #1405
  // round 4, E1), and company_users_user_id_fkey (996, checked at COMMIT) would then refuse the whole delete. Sweep it.
  await deleteMemberships(userId);

  reportStranded('deleteUser', userId, stranded);
  log.info('deleteUser', { userId }, 'AdminUserActionsService');
  return stranded;
}

/**
 * Reset a user's onboarding state so they go through the company wizard again
 * on next login. Removes all company links and clears sessions. Throws
 * SoleOwnerError, having written nothing, when the user is a company's only owner.
 */
export async function resetOnboarding(userId: string): Promise<void> {
  // A missing user is a 404 before anything is written (review #1405 round 5, L3): the company_users DELETE below would
  // remove orphan memberships left under that id, and the 404 commits what it wrote. A plain read (no lock), as
  // deleteUser and forceLogout do; the UPDATE below still decides when the user goes concurrently.
  if ((await sql`SELECT 1 FROM users WHERE id = ${userId}`).length === 0) throw new AdminRequestError(404, 'User not found');
  await removeFromEveryCompany(userId, true); // company_users first (LOCK ORDER above)
  // The UPDATE decides existence when the user was deleted since the read above: a 404 before the route's audit row
  // (breaker #1405 round 3, D2). The concurrent delete removed the memberships itself, so nothing is lost.
  const updated = await sql`
    UPDATE users
    SET onboarding_completed = false,
        updated_at           = NOW()
    WHERE id = ${userId}
    RETURNING id
  `;
  if (updated.length === 0) throw new AdminRequestError(404, 'User not found');
  await sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;
  log.info('resetOnboarding — user must re-onboard', { userId }, 'AdminUserActionsService');
}
