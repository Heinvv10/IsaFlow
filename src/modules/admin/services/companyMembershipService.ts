/**
 * Admin portal: change or remove one user's membership of one company.
 *
 * Runs on the platform_admin pool inside withPlatformAdmin's request
 * transaction, so the row lock and the advisory lock below hold until COMMIT.
 * Migration 883's trigger already refuses a portal grant outside
 * ALLOWED_COMPANY_ROLES (never `owner`); it keeps no last-owner rule for the
 * portal, so that rule lives here (Hein, 2026-10-16): the portal never demotes
 * or removes a company's last owner. The lock key is the trigger's own, so an
 * app-side owner demotion racing this one is judged after it.
 *
 * Every refusal is a CompanyMembershipError, which the routes answer as a 4xx
 * with its message; anything else propagates (a 500 rolls the request back).
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { ErrorCode } from '@/lib/apiResponse';
import { ALLOWED_COMPANY_ROLES } from './adminUserActionsService';

export type CompanyMembershipErrorCode = 'NOT_FOUND' | 'LAST_OWNER' | 'INVALID_ROLE';

export class CompanyMembershipError extends Error {
  constructor(public readonly code: CompanyMembershipErrorCode, message: string) {
    super(message);
    this.name = 'CompanyMembershipError';
  }
}

/** The API error a route answers for each refusal: 404, 409, 400. */
export const MEMBERSHIP_ERROR_CODE: Record<CompanyMembershipErrorCode, ErrorCode> = {
  NOT_FOUND: ErrorCode.NOT_FOUND, LAST_OWNER: ErrorCode.CONFLICT, INVALID_ROLE: ErrorCode.BAD_REQUEST,
};

/** Lock the membership row; throws NOT_FOUND when the user is not linked to the company. */
async function lockMembership(userId: string, companyId: string): Promise<string> {
  const rows = await sql<{ role: string }>`
    SELECT role FROM company_users
    WHERE user_id = ${userId} AND company_id = ${companyId}::uuid
    FOR UPDATE
  `;
  const role = rows[0]?.role;
  if (role === undefined) {
    throw new CompanyMembershipError('NOT_FOUND', 'This user is not linked to that company');
  }
  return role;
}

/** Throws LAST_OWNER when no OTHER person owns the company (counted as migration 883 counts). */
async function assertAnotherOwner(userId: string, companyId: string, refusal: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('company_owners:' || ${companyId}::text, 0))`;
  const rows = await sql<{ n: number }>`
    SELECT count(DISTINCT lower(user_id::text))::int AS n FROM company_users
    WHERE company_id = ${companyId}::uuid AND role = 'owner' AND lower(user_id::text) <> lower(${userId})
  `;
  if ((rows[0]?.n ?? 0) === 0) throw new CompanyMembershipError('LAST_OWNER', refusal);
}

export async function removeUserFromCompany(userId: string, companyId: string): Promise<{ previousRole: string }> {
  const previousRole = await lockMembership(userId, companyId);
  if (previousRole === 'owner') {
    await assertAnotherOwner(userId, companyId, 'Cannot remove the last owner of the company');
  }
  await sql`DELETE FROM company_users WHERE user_id = ${userId} AND company_id = ${companyId}::uuid`;
  log.info('removeUserFromCompany', { userId, companyId, previousRole }, 'AdminCompanyMembership');
  return { previousRole };
}

export async function setUserCompanyRole(
  userId: string,
  companyId: string,
  role: string,
): Promise<{ previousRole: string; role: string }> {
  if (!ALLOWED_COMPANY_ROLES.includes(role)) {
    throw new CompanyMembershipError('INVALID_ROLE', `Role must be one of: ${ALLOWED_COMPANY_ROLES.join(', ')}`);
  }
  const previousRole = await lockMembership(userId, companyId);
  if (previousRole === role) return { previousRole, role };
  if (previousRole === 'owner') {
    await assertAnotherOwner(userId, companyId, "Cannot change role: this is the company's last owner");
  }
  await sql`
    UPDATE company_users SET role = ${role}
    WHERE user_id = ${userId} AND company_id = ${companyId}::uuid
  `;
  log.info('setUserCompanyRole', { userId, companyId, previousRole, role }, 'AdminCompanyMembership');
  return { previousRole, role };
}
