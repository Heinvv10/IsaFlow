/**
 * User Access Service
 * Manages company users and invitations — mirrors Sage's "Control User Access".
 */

import crypto from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

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
  token: string;
  expiresAt: string;
  createdAt: string;
  emailSentAt: string | null;
  emailError: string | null;
}

export interface InvitationResult {
  autoAdded: boolean;
  invitation?: PendingInvitation;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidRole(role: string): role is CompanyRole {
  return (VALID_ROLES as readonly string[]).includes(role);
}

async function countOwners(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*) AS cnt FROM company_users
    WHERE company_id = ${companyId}::UUID AND role = 'owner'
  `) as Row[];
  return parseInt(rows[0]?.cnt ?? '0', 10);
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
  `) as Row[];

  return rows.map((r: Row) => ({
    userId: r.user_id,
    name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email,
    email: r.email,
    role: r.role,
    joinedAt: toIso(r.created_at) ?? '',
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

  // Prevent stripping last owner
  const currentRows = (await sql`
    SELECT role FROM company_users
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::UUID
  `) as Row[];

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
  // Prevent removing last owner
  const rows = (await sql`
    SELECT role FROM company_users
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::UUID
  `) as Row[];

  if (rows[0]?.role === 'owner') {
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

// ── Invitations ───────────────────────────────────────────────────────────────

export async function createInvitation(
  companyId: string,
  email: string,
  role: string,
  invitedBy: string,
): Promise<InvitationResult> {
  if (!isValidRole(role)) {
    throw new Error(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
  }

  // Check if a user with this email already exists
  const existing = (await sql`
    SELECT id FROM users WHERE email = ${email} LIMIT 1
  `) as Row[];

  if (existing.length > 0) {
    const existingUserId = existing[0].id as string;

    // Check if already in company
    const alreadyMember = (await sql`
      SELECT 1 FROM company_users
      WHERE company_id = ${companyId}::UUID AND user_id = ${existingUserId}::UUID
    `) as Row[];

    if (alreadyMember.length > 0) {
      throw new Error('This user is already a member of the company.');
    }

    // Auto-add directly
    await sql`
      INSERT INTO company_users (company_id, user_id, role)
      VALUES (${companyId}::UUID, ${existingUserId}::UUID, ${role})
      ON CONFLICT (company_id, user_id) DO NOTHING
    `;
    log.info('User auto-added to company', { companyId, email, role }, 'accounting');
    return { autoAdded: true };
  }

  // Create invitation row — upsert on (company_id, email) to allow re-invite
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const rows = (await sql`
    INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at)
    VALUES (${companyId}::UUID, ${email}, ${role}, ${invitedBy}, ${token}, ${expiresAt}::TIMESTAMPTZ)
    ON CONFLICT (company_id, email) DO UPDATE SET
      role = EXCLUDED.role,
      invited_by = EXCLUDED.invited_by,
      token = EXCLUDED.token,
      expires_at = EXCLUDED.expires_at,
      accepted_at = NULL,
      created_at = NOW()
    RETURNING *
  `) as Row[];

  const inv = rows[0];
  log.info('Invitation created', { companyId, email, role }, 'accounting');
  return {
    autoAdded: false,
    invitation: mapInvitation(inv),
  };
}

export async function listPendingInvitations(companyId: string): Promise<PendingInvitation[]> {
  const rows = (await sql`
    SELECT * FROM company_invitations
    WHERE company_id = ${companyId}::UUID
      AND accepted_at IS NULL
      AND expires_at > NOW()
    ORDER BY created_at DESC
  `) as Row[];
  return rows.map(mapInvitation);
}

export async function markInvitationEmailSent(invitationId: string): Promise<void> {
  await sql`
    UPDATE company_invitations
    SET email_sent_at = NOW(), email_error = NULL
    WHERE id = ${invitationId}::UUID
  `;
}

export async function markInvitationEmailFailed(invitationId: string, error: string): Promise<void> {
  await sql`
    UPDATE company_invitations
    SET email_error = ${error}
    WHERE id = ${invitationId}::UUID
  `;
}

export async function cancelInvitation(invitationId: string, companyId: string): Promise<void> {
  await sql`
    DELETE FROM company_invitations
    WHERE id = ${invitationId}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Invitation cancelled', { invitationId, companyId }, 'accounting');
}

export async function acceptInvitation(token: string, userId: string): Promise<void> {
  const rows = (await sql`
    SELECT * FROM company_invitations
    WHERE token = ${token}
      AND accepted_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `) as Row[];

  if (rows.length === 0) {
    throw new Error('Invitation not found or has expired.');
  }

  const inv = rows[0];

  await sql`
    INSERT INTO company_users (company_id, user_id, role)
    VALUES (${inv.company_id}::UUID, ${userId}::UUID, ${inv.role})
    ON CONFLICT (company_id, user_id) DO NOTHING
  `;

  await sql`
    UPDATE company_invitations SET accepted_at = NOW() WHERE id = ${inv.id}::UUID
  `;

  log.info('Invitation accepted', { token, userId, companyId: inv.company_id }, 'accounting');
}

// ── Mapper ────────────────────────────────────────────────────────────────────

function mapInvitation(r: Row): PendingInvitation {
  return {
    id: r.id,
    companyId: r.company_id,
    email: r.email,
    role: r.role,
    invitedBy: r.invited_by,
    token: r.token,
    expiresAt: toIso(r.expires_at) ?? '',
    createdAt: toIso(r.created_at) ?? '',
    emailSentAt: r.email_sent_at ? (toIso(r.email_sent_at) ?? null) : null,
    emailError: r.email_error ?? null,
  };
}
