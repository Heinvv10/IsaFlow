/**
 * User Access Service
 * Manages company users and invitations — mirrors Sage's "Control User Access".
 * Invitation operations split to userInvitationService.ts.
 */

import crypto from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';


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
  autoAdded: boolean;
  invitation?: InvitationWithToken;
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

/** S-04: a non-owner tried to change or remove an owner. The route answers 403. */
export class OwnerProtectedError extends Error {
  constructor() {
    super('Only an owner can change or remove another owner.');
    this.name = 'OwnerProtectedError';
  }
}

// The target's role, read under its row lock so it cannot change between this
// check and the write (an owner promoting the target while an admin demotes
// it). When the target is an owner, also take the per-company owner lock the
// member role guard takes (migs 883/886), after the row lock as the trigger
// does, so the last-owner count below is the one the write is judged by.
async function lockTargetRole(
  companyId: string,
  userId: string,
  actorRole: string,
): Promise<string | undefined> {
  const rows = (await sql`
    SELECT role FROM company_users
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}
    FOR UPDATE
  `) as DbRow[];
  const role = rows[0]?.role as string | undefined;
  if (role !== 'owner') return role;
  if (actorRole !== 'owner') throw new OwnerProtectedError();
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`company_owners:${companyId}`}, 0))`;
  return role;
}

export async function updateCompanyUserRole(
  companyId: string,
  userId: string,
  newRole: string,
  actorRole: string,
): Promise<void> {
  if (!isValidRole(newRole)) {
    throw new Error(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
  }

  const currentRole = await lockTargetRole(companyId, userId, actorRole);
  if (currentRole === 'owner' && newRole !== 'owner') {
    const ownerCount = await countOwners(companyId);
    if (ownerCount <= 1) {
      throw new Error('Cannot change role: this is the last owner of the company.');
    }
  }

  await sql`
    UPDATE company_users
    SET role = ${newRole}
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}
  `;
  log.info('Company user role updated', { companyId, userId, newRole }, 'accounting');
}

export async function removeCompanyUser(companyId: string, userId: string, actorRole: string): Promise<void> {
  if ((await lockTargetRole(companyId, userId, actorRole)) === 'owner') {
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
  acceptInvitation,
} from './userInvitationService';

// Suppress unused import warning — crypto is used only in the invitation file now
void crypto;
