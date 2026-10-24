/**
 * Member role changes and removals, on the migration_admin pool (S-07d,
 * migration 937): no app role may UPDATE or DELETE company_users, because SQL
 * injected on an app pool can forge the claims the member guard judges (a
 * member made itself owner; an owner's forged claims removed the others).
 *
 * company_users_role_guard judges only app_user and app_service, so its rules
 * for them are checked here, against the memberships as they stand, with
 * `actorUserId` the verified caller: a valid role (RC002); the actor an owner
 * or admin now (RC001); only an owner grants the owner role, or changes or
 * removes an owner (RC003, RC010), read from the actor's own row under its
 * row lock, then the per-company owner lock every owner demotion takes; never
 * the last owner (RC005; the guard's RC011 refuses
 * it again for this role); nobody removes themselves (RC006); and only the
 * role column is written (RC004).
 */

import type { PoolClient } from 'pg';
import { log } from '@/lib/logger';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { OwnerProtectedError, OWNER_GRANT_REFUSED, ownerLockKey } from './ownerLock';
import { VALID_ROLES } from './userInvitationService';


/** RC001 on the migration_admin pool: the actor is not an owner or admin of the company. Routes answer 403. */
export class MemberRoleForbiddenError extends Error {
  constructor(message = 'Only owners and admins can change the members of a company.') {
    super(message);
    this.name = 'MemberRoleForbiddenError';
  }
}

/**
 * The target's and the actor's membership rows, locked together in id order
 * (two members acting on each other at once queue instead of deadlocking),
 * then, when an owner is involved, the owner lock: rows first, then the
 * owner lock, the guard's order. Locked rows are read as last committed, so a
 * concurrent demotion of either is judged before or after this write, never
 * during it. Returns whether the target is an owner.
 */
async function authorize(client: PoolClient, companyId: string, userId: string, actorUserId: string,
  grantsOwner: boolean): Promise<boolean> {
  // Owner-ness of the target as the guard judges a row that leaves
  // (company_member_role_is_owner: any case, any whitespace); the actor's as
  // the guard judges the actor (exactly 'owner' or 'admin'), by person.
  const rows = (await client.query<{ role: string; is_owner: boolean; is_target: boolean; is_actor: boolean }>(
    `SELECT role, public.company_member_role_is_owner(role) AS is_owner,
            user_id = $2 AS is_target, lower(user_id::TEXT) = lower($3) AS is_actor
       FROM company_users
      WHERE company_id = $1::UUID AND (user_id = $2 OR lower(user_id::TEXT) = lower($3))
      ORDER BY id FOR UPDATE`,
    [companyId, userId, actorUserId],
  )).rows;
  const target = rows.find((r) => r.is_target);
  if (!target) throw new Error('That user is not a member of this company.');
  const actorRoles = rows.filter((r) => r.is_actor).map((r) => r.role);
  if (target.is_owner || grantsOwner) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ownerLockKey(companyId)]);
    if (!actorRoles.includes('owner')) throw new OwnerProtectedError(target.is_owner ? undefined : OWNER_GRANT_REFUSED);
  } else if (!actorRoles.includes('owner') && !actorRoles.includes('admin')) {
    throw new MemberRoleForbiddenError();
  }
  return target.is_owner;
}

/** A member write that waited past migrationAdminTx's lock_timeout (55P03) or lost a deadlock (40P01): the route answers 409. */
export function isMemberWriteBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '55P03' || code === '40P01';
}

/** Throws `message` when `userId` is the company's only owner (by person). */
async function refuseLastOwner(client: PoolClient, companyId: string, userId: string, message: string): Promise<void> {
  const others = await client.query<{ n: number }>(
    `SELECT count(DISTINCT lower(user_id::TEXT))::int AS n FROM company_users
      WHERE company_id = $1::UUID AND role = 'owner' AND lower(user_id::TEXT) <> lower($2)`,
    [companyId, userId],
  );
  if ((others.rows[0]?.n ?? 0) === 0) throw new Error(message);
}

export async function updateCompanyUserRole(
  companyId: string,
  userId: string,
  newRole: string,
  actorUserId: string,
): Promise<void> {
  if (!(VALID_ROLES as readonly string[]).includes(newRole)) {
    throw new Error(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
  }
  await migrationAdminTx('change member role', async (client) => {
    if (await authorize(client, companyId, userId, actorUserId, newRole === 'owner') && newRole !== 'owner') {
      await refuseLastOwner(client, companyId, userId, 'Cannot change role: this is the last owner of the company.');
    }
    await client.query('UPDATE company_users SET role = $3 WHERE company_id = $1::UUID AND user_id = $2', [companyId, userId, newRole]);
  });
  log.info('Company user role updated', { companyId, userId, newRole }, 'accounting');
}

export async function removeCompanyUser(companyId: string, userId: string, actorUserId: string): Promise<void> {
  if (userId.toLowerCase() === actorUserId.toLowerCase()) throw new Error('You cannot remove yourself from the company.');
  await migrationAdminTx('remove member', async (client) => {
    if (await authorize(client, companyId, userId, actorUserId, false)) {
      await refuseLastOwner(client, companyId, userId, 'Cannot remove the last owner of the company.');
    }
    await client.query('DELETE FROM company_users WHERE company_id = $1::UUID AND user_id = $2', [companyId, userId]);
  });
  log.info('Company user removed', { companyId, userId }, 'accounting');
}
