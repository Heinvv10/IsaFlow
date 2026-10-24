/**
 * User Access Service
 * Manages company users and invitations — mirrors Sage's "Control User Access".
 * Invitation operations split to userInvitationService.ts.
 */

import crypto from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { lockOwnersAndRequireOwner, OwnerProtectedError, OWNER_GRANT_REFUSED, ownerLockKey } from './ownerLock';

export { OwnerProtectedError } from './ownerLock';


export const VALID_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
type CompanyRole = (typeof VALID_ROLES)[number];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompanyUserRecord {
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
}

export interface PendingInvitation {
  id: string;
  companyId: string;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
  emailSentAt: string | null;
  emailError: string | null;
}

export interface InvitationWithToken extends PendingInvitation {
  token: string;
}

export interface InvitationResult {
  /** Always false: an existing account is invited by email, never added (S-07c). */
  autoAdded: false;
  invitation: InvitationWithToken;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidRole(role: string): role is CompanyRole {
  return (VALID_ROLES as readonly string[]).includes(role);
}

async function countOwners(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*) AS cnt FROM company_users
    WHERE company_id = ${companyId}::UUID AND role = 'owner'
  `) as DbRow[];
  return parseInt(String(rows[0]?.cnt ?? '0'), 10);
}

function toIso(val: Date | string | null): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  return val;
}

// ── Company Users ─────────────────────────────────────────────────────────────
//
// `company_users.user_id` is TEXT and `users.id` is VARCHAR — user identity is a
// string in this schema, not a uuid. NEVER cast the parameter in a
// `user_id = ${userId}` comparison to ::UUID: Postgres has no `text = uuid`
// operator, so the query throws at runtime (500) rather than returning a wrong
// answer. `company_id` IS a uuid and keeps its cast.

// Reads through company_member_directory (mig 716), not a plain JOIN on
// `users`: under withAuth (app_user) `users_self_read` hides every other
// member's users row, so the JOIN listed each viewer only themselves (R-152).
// The function mirrors cu_select — owner/admin get every member, lower roles
// only their own row — and refuses (42501) outside the caller's own company.
export async function listCompanyUsers(companyId: string): Promise<CompanyUserRecord[]> {
  const rows = (await sql`
    SELECT m.user_id, m.first_name, m.last_name, m.email, m.role, m.created_at
    FROM company_member_directory(${companyId}::UUID) m
    ORDER BY m.created_at ASC
  `) as DbRow[];

  return rows.map((r: DbRow) => ({
    userId: r.user_id as string,
    name: `${(r.first_name as string) ?? ''} ${(r.last_name as string) ?? ''}`.trim() || (r.email as string),
    email: r.email as string,
    role: r.role as string,
    joinedAt: toIso(r.created_at as string | Date | null) ?? '',
  }));
}

// The target's role, read under its row lock so it cannot change between this
// check and the removal. When the target is an owner, take the per-company
// owner lock and require a live owner actor (ownerLock.ts), after the row lock
// as the trigger does, so the last-owner count below is the one the removal is
// judged by.
async function lockTargetRole(companyId: string, userId: string, actorUserId: string): Promise<string | undefined> {
  const rows = (await sql`
    SELECT role FROM company_users
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}
    FOR UPDATE
  `) as DbRow[];
  const role = rows[0]?.role as string | undefined;
  if (role !== 'owner') return role;
  await lockOwnersAndRequireOwner(companyId, actorUserId);
  return role;
}

/** RC001 for a write on the migration_admin pool: the actor is not an owner or admin of the company. Routes answer 403. */
export class MemberRoleForbiddenError extends Error {
  constructor(message = 'Only owners and admins can change the members of a company.') {
    super(message);
    this.name = 'MemberRoleForbiddenError';
  }
}

/**
 * Change a member's role, on the migration_admin pool (S-07d, migration 935):
 * no app role may UPDATE company_users, because SQL injected on an app pool
 * can forge the claims the member guard judges (a member made itself owner).
 * company_users_role_guard judges only app_user and app_service, so its rules
 * for them are checked here, against the memberships as they stand, with
 * `actorUserId` the verified caller: a valid role (RC002); the actor an owner
 * or admin now (RC001); only an owner grants the owner role or changes an
 * owner (RC003, RC010), read after the per-company owner lock every owner
 * demotion takes; never the last owner (RC005; the guard's RC011 refuses it
 * again for this role); and only the role column is written (RC004).
 */
export async function updateCompanyUserRole(
  companyId: string,
  userId: string,
  newRole: string,
  actorUserId: string,
): Promise<void> {
  if (!isValidRole(newRole)) {
    throw new Error(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
  }

  await migrationAdminTx('change member role', async (client) => {
    // Bounded: this holds one of the migration_admin pool's few connections.
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    // The target's role under its row lock, so it cannot change between this
    // check and the write; then the owner lock, in the guard's order.
    const target = await client.query<{ role: string }>(
      'SELECT role FROM company_users WHERE company_id = $1::UUID AND user_id = $2 FOR UPDATE', [companyId, userId],
    );
    const currentRole = target.rows[0]?.role;
    if (currentRole === undefined) throw new Error('That user is not a member of this company.');
    const ownerInvolved = currentRole === 'owner' || newRole === 'owner';
    if (ownerInvolved) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ownerLockKey(companyId)]);
    }
    // By person, lower-cased, as the guard counts owners. Without the owner
    // lock, the actor's row is held so a concurrent demotion is judged before
    // or after this write, not during it.
    const actor = await client.query<{ role: string }>(
      `SELECT role FROM company_users WHERE company_id = $1::UUID AND lower(user_id::TEXT) = lower($2)
        ${ownerInvolved ? '' : 'FOR SHARE'}`,
      [companyId, actorUserId],
    );
    const roles = actor.rows.map((r) => r.role);
    if (ownerInvolved) {
      if (!roles.includes('owner')) throw new OwnerProtectedError(currentRole === 'owner' ? undefined : OWNER_GRANT_REFUSED);
    } else if (!roles.includes('owner') && !roles.includes('admin')) {
      throw new MemberRoleForbiddenError();
    }
    if (currentRole === 'owner' && newRole !== 'owner') {
      const others = await client.query<{ n: number }>(
        `SELECT count(DISTINCT lower(user_id::TEXT))::int AS n FROM company_users
          WHERE company_id = $1::UUID AND role = 'owner' AND lower(user_id::TEXT) <> lower($2)`,
        [companyId, userId],
      );
      if ((others.rows[0]?.n ?? 0) === 0) throw new Error('Cannot change role: this is the last owner of the company.');
    }
    await client.query('UPDATE company_users SET role = $3 WHERE company_id = $1::UUID AND user_id = $2', [companyId, userId, newRole]);
  });
  log.info('Company user role updated', { companyId, userId, newRole }, 'accounting');
}

export async function removeCompanyUser(companyId: string, userId: string, actorUserId: string): Promise<void> {
  if ((await lockTargetRole(companyId, userId, actorUserId)) === 'owner') {
    const ownerCount = await countOwners(companyId);
    if (ownerCount <= 1) {
      throw new Error('Cannot remove the last owner of the company.');
    }
  }

  await sql`
    DELETE FROM company_users
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}
  `;
  log.info('Company user removed', { companyId, userId }, 'accounting');
}

// ── Invitations — re-exported from userInvitationService.ts ──────────────────
export {
  createInvitation,
  listPendingInvitations,
  markInvitationEmailSent,
  markInvitationEmailFailed,
  cancelInvitation,
} from './userInvitationService';

// Suppress unused import warning — crypto is used only in the invitation file now
void crypto;
