/**
 * User Invitation Service
 * Invitation CRUD operations — split from userAccessService.ts.
 */

import crypto from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PendingInvitation, InvitationWithToken, InvitationResult } from './userAccessService';
import type { DbRow } from '@/types/db';


export const VALID_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
type CompanyRole = (typeof VALID_ROLES)[number];

function isValidRole(role: string): role is CompanyRole {
  return (VALID_ROLES as readonly string[]).includes(role);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function toIso(val: Date | string | null): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  return val;
}

function mapInvitation(r: DbRow): PendingInvitation {
  return {
    id: r.id as string,
    companyId: r.company_id as string,
    email: r.email as string,
    role: r.role as string,
    invitedBy: r.invited_by as string,
    expiresAt: toIso(r.expires_at as string | Date | null) ?? '',
    createdAt: toIso(r.created_at as string | Date | null) ?? '',
    emailSentAt: r.email_sent_at ? (toIso(r.email_sent_at as string | Date | null) ?? null) : null,
    emailError: (r.email_error as string | null) ?? null,
  };
}

export async function createInvitation(
  companyId: string,
  email: string,
  role: string,
  invitedBy: string,
): Promise<InvitationResult> {
  if (!isValidRole(role)) {
    throw new Error(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
  }

  const existing = (await sql`
    SELECT id FROM users WHERE email = ${email} LIMIT 1
  `) as DbRow[];

  if (existing.length > 0) {
    const existingUserId = existing[0]!.id as string;

    const alreadyMember = (await sql`
      SELECT 1 FROM company_users
      WHERE company_id = ${companyId}::UUID AND user_id = ${existingUserId}
    `) as DbRow[];

    if (alreadyMember.length > 0) {
      throw new Error('This user is already a member of the company.');
    }

    await sql`
      INSERT INTO company_users (company_id, user_id, role)
      VALUES (${companyId}::UUID, ${existingUserId}::UUID, ${role})
      ON CONFLICT (company_id, user_id) DO NOTHING
    `;
    log.info('User auto-added to company', { companyId, email, role }, 'accounting');
    return { autoAdded: true };
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const rows = (await sql`
    INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at)
    VALUES (${companyId}::UUID, ${email}, ${role}, ${invitedBy}, ${tokenHash}, ${expiresAt}::TIMESTAMPTZ)
    ON CONFLICT (company_id, email) DO UPDATE SET
      role = EXCLUDED.role,
      invited_by = EXCLUDED.invited_by,
      token = EXCLUDED.token,
      expires_at = EXCLUDED.expires_at,
      accepted_at = NULL,
      created_at = NOW()
    RETURNING *
  `) as DbRow[];

  const inv = rows[0]!;
  log.info('Invitation created', { companyId, email, role }, 'accounting');
  return {
    autoAdded: false,
    invitation: { ...mapInvitation(inv), token: rawToken } as InvitationWithToken,
  };
}

export async function listPendingInvitations(companyId: string): Promise<PendingInvitation[]> {
  const rows = (await sql`
    SELECT id, company_id, email, role, invited_by,
           expires_at, created_at, email_sent_at, email_error
    FROM company_invitations
    WHERE company_id = ${companyId}::UUID
      AND accepted_at IS NULL
      AND expires_at > NOW()
    ORDER BY created_at DESC
  `) as DbRow[];
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
  const tokenHash = hashToken(token);
  const rows = (await sql`
    SELECT * FROM company_invitations
    WHERE token = ${tokenHash}
      AND accepted_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `) as DbRow[];

  if (rows.length === 0) {
    throw new Error('Invitation not found or has expired.');
  }

  const inv = rows[0]!;

  await sql`
    INSERT INTO company_users (company_id, user_id, role)
    VALUES (${inv.company_id as string}::UUID, ${userId}::UUID, ${inv.role as string})
    ON CONFLICT (company_id, user_id) DO NOTHING
  `;

  await sql`
    UPDATE company_invitations SET accepted_at = NOW() WHERE id = ${inv.id as string}::UUID
  `;

  log.info('Invitation accepted', { token, userId, companyId: inv.company_id }, 'accounting');
}
