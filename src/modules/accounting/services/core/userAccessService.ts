/**
 * User Access Service
 * Manages company users and invitations — mirrors Sage's "Control User Access".
 * Invitation operations split to userInvitationService.ts.
 */

import crypto from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';


const VALID_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
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

export async function listCompanyUsers(companyId: string): Promise<CompanyUserRecord[]> {
  const rows = (await sql`
    SELECT
      cu.user_id,
      u.first_name,
      u.last_name,
      u.email,
      cu.role,
      cu.created_at
    FROM company_users cu
    JOIN users u ON u.id = cu.user_id::VARCHAR
    WHERE cu.company_id = ${companyId}::UUID
    ORDER BY cu.created_at ASC
  `) as DbRow[];

  return rows.map((r: DbRow) => ({
    userId: r.user_id as string,
    name: `${(r.first_name as string) ?? ''} ${(r.last_name as string) ?? ''}`.trim() || (r.email as string),
    email: r.email as string,
    role: r.role as string,
    joinedAt: toIso(r.created_at as string | Date | null) ?? '',
  }));
}

export async function updateCompanyUserRole(
  companyId: string,
  userId: string,
  newRole: string,
): Promise<void> {
  if (!isValidRole(newRole)) {
    throw new Error(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
  }

  const currentRows = (await sql`
    SELECT role FROM company_users
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::UUID
  `) as DbRow[];

  const currentRole = currentRows[0]?.role as string | undefined;
  if (currentRole === 'owner' && newRole !== 'owner') {
    const ownerCount = await countOwners(companyId);
    if (ownerCount <= 1) {
      throw new Error('Cannot change role: this is the last owner of the company.');
    }
  }

  await sql`
    UPDATE company_users
    SET role = ${newRole}
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::UUID
  `;
  log.info('Company user role updated', { companyId, userId, newRole }, 'accounting');
}

export async function removeCompanyUser(companyId: string, userId: string): Promise<void> {
  const rows = (await sql`
    SELECT role FROM company_users
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::UUID
  `) as DbRow[];

  if ((rows[0]?.role as string | undefined) === 'owner') {
    const ownerCount = await countOwners(companyId);
    if (ownerCount <= 1) {
      throw new Error('Cannot remove the last owner of the company.');
    }
  }

  await sql`
    DELETE FROM company_users
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::UUID
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
