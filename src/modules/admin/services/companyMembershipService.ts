/**
 * Admin portal: link a user to a company, change that link's role, or remove it.
 *
 * Runs on the platform_admin pool inside withPlatformAdmin's request
 * transaction, so the row lock and the advisory lock below hold until COMMIT.
 * Migration 883's trigger already refuses a portal grant outside
 * ALLOWED_COMPANY_ROLES (never `owner`); it keeps no last-owner rule for the
 * portal, so that rule lives here (Hein, 2026-10-16): the portal never demotes
 * or removes a company's last owner. Linking never changes an existing link
 * (it used to upsert the role, which demoted an owner unchecked); the role is
 * changed only through setUserCompanyRole.
 *
 * Matching: a user id is compared case-insensitively (users.id is text; 883
 * counts owners the same way), an owner is `lower(btrim(role)) = 'owner'`
 * (stricter than 883's exact match), and the lock key is the trigger's own (`company_owners:` + the uuid's canonical text), so an app-side
 * owner demotion racing this one is judged after it.
 *
 * Every refusal is a CompanyMembershipError, raised when nothing has been
 * written (a no-op or aborted insert at most), which the routes answer as a 4xx with its message; anything else propagates (a 500
 * rolls the request back).
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { ErrorCode } from '@/lib/apiResponse';
import { ALLOWED_COMPANY_ROLES } from './adminUserActionsService';

export type CompanyMembershipErrorCode = 'NOT_FOUND' | 'LAST_OWNER' | 'INVALID_ROLE' | 'ALREADY_LINKED';

export class CompanyMembershipError extends Error {
  constructor(public readonly code: CompanyMembershipErrorCode, message: string) {
    super(message);
    this.name = 'CompanyMembershipError';
  }
}

/** The API error a route answers for each refusal: 404, 409, 400, 409. */
export const MEMBERSHIP_ERROR_CODE: Record<CompanyMembershipErrorCode, ErrorCode> = {
  NOT_FOUND: ErrorCode.NOT_FOUND, LAST_OWNER: ErrorCode.CONFLICT,
  INVALID_ROLE: ErrorCode.BAD_REQUEST, ALREADY_LINKED: ErrorCode.CONFLICT,
};

const isOwner = (role: string) => role.trim().toLowerCase() === 'owner';

function assertGrantable(role: string): void {
  if (!ALLOWED_COMPANY_ROLES.includes(role)) {
    throw new CompanyMembershipError('INVALID_ROLE', `Role must be one of: ${ALLOWED_COMPANY_ROLES.join(', ')}`);
  }
}

/**
 * Lock the user's membership row(s) and return the role. One person can hold
 * case-variant rows (the unique key is case-sensitive); the DELETE / UPDATE
 * below match them all, so an owner row among them makes the link an owner's.
 * Throws NOT_FOUND when the user is not linked to the company.
 */
async function lockMembership(userId: string, companyId: string): Promise<string> {
  const rows = await sql<{ role: string }>`
    SELECT role FROM company_users
    WHERE lower(user_id::text) = lower(${userId}) AND company_id = ${companyId}::uuid
    ORDER BY (lower(btrim(role)) = 'owner') DESC
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
  // The count below sees a racing demotion only because each statement takes a
  // fresh snapshot after the lock: READ COMMITTED. Refuse to judge under any other.
  const iso = await sql<{ level: string }>`SELECT current_setting('transaction_isolation') AS level`;
  if (iso[0]?.level !== 'read committed') {
    throw new Error(`last-owner check needs READ COMMITTED, got ${iso[0]?.level ?? 'unknown'}`);
  }
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('company_owners:' || ${companyId}::uuid::text, 0))`;
  const rows = await sql<{ n: number }>`
    SELECT count(DISTINCT lower(user_id::text))::int AS n FROM company_users
    WHERE company_id = ${companyId}::uuid AND lower(btrim(role)) = 'owner'
      AND lower(user_id::text) <> lower(${userId})
  `;
  if ((rows[0]?.n ?? 0) === 0) throw new CompanyMembershipError('LAST_OWNER', refusal);
}

/** Link a user to a company. An existing link is refused (ALREADY_LINKED), never re-roled. */
export async function addUserToCompany(userId: string, companyId: string, role: string): Promise<void> {
  assertGrantable(role);
  const rows = await sql<{ id: string }>`
    INSERT INTO company_users (user_id, company_id, role, created_at)
    SELECT ${userId}, ${companyId}::uuid, ${role}, NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM company_users
      WHERE lower(user_id::text) = lower(${userId}) AND company_id = ${companyId}::uuid
    )
    ON CONFLICT (user_id, company_id) DO NOTHING
    RETURNING id
  `.catch((err: unknown) => {
    // A missing company (company_users_company_id_fkey). The failed statement has
    // aborted the transaction, so the 404's COMMIT writes nothing.
    if ((err as { code?: string }).code === '23503') {
      throw new CompanyMembershipError('NOT_FOUND', 'That company does not exist');
    }
    throw err;
  });
  if (rows.length === 0) {
    throw new CompanyMembershipError('ALREADY_LINKED', 'This user is already linked to that company; change the role instead');
  }
  log.info('addUserToCompany', { userId, companyId, role }, 'AdminCompanyMembership');
}

export async function removeUserFromCompany(userId: string, companyId: string): Promise<{ previousRole: string }> {
  const previousRole = await lockMembership(userId, companyId);
  if (isOwner(previousRole)) {
    await assertAnotherOwner(userId, companyId, 'Cannot remove the last owner of the company');
  }
  await sql`
    DELETE FROM company_users
    WHERE lower(user_id::text) = lower(${userId}) AND company_id = ${companyId}::uuid
  `;
  log.info('removeUserFromCompany', { userId, companyId, previousRole }, 'AdminCompanyMembership');
  return { previousRole };
}

/** Change a link's role; `changed` is false (and nothing is written) when it already has that role. */
export async function setUserCompanyRole(
  userId: string,
  companyId: string,
  role: string,
): Promise<{ previousRole: string; changed: boolean }> {
  assertGrantable(role);
  const previousRole = await lockMembership(userId, companyId);
  if (previousRole === role) return { previousRole, changed: false };
  if (isOwner(previousRole)) {
    await assertAnotherOwner(userId, companyId, "Cannot change role: this is the company's last owner");
  }
  await sql`
    UPDATE company_users SET role = ${role}
    WHERE lower(user_id::text) = lower(${userId}) AND company_id = ${companyId}::uuid
  `;
  log.info('setUserCompanyRole', { userId, companyId, previousRole, role }, 'AdminCompanyMembership');
  return { previousRole, changed: true };
}
