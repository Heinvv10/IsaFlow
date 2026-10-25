/**
 * User Access Service
 * Manages company users and invitations — mirrors Sage's "Control User Access".
 * Invitation operations split to userInvitationService.ts.
 */

import crypto from 'crypto';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';

export { OwnerProtectedError } from './ownerLock';


export const VALID_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;

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

// Role changes and removals run on the migration_admin pool (S-07d): memberWrites.ts.
export { updateCompanyUserRole, removeCompanyUser, MemberRoleForbiddenError } from './memberWrites';

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
