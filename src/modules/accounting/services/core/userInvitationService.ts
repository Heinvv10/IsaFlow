/**
 * User Invitation Service
 * Invitation CRUD operations — split from userAccessService.ts.
 */

import crypto from 'crypto';
import { sql } from '@/lib/neon';
import { hashInviteToken } from '@/lib/auth/inviteToken';
import { log } from '@/lib/logger';
import type { PoolClient } from 'pg';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import type { PendingInvitation, InvitationWithToken, InvitationResult } from './userAccessService';
import type { DbRow } from '@/types/db';


export const VALID_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
type CompanyRole = (typeof VALID_ROLES)[number];

function isValidRole(role: string): role is CompanyRole {
  return (VALID_ROLES as readonly string[]).includes(role);
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

/**
 * Create or refresh `email`'s invitation to `companyId` and return its raw
 * token, for the invite email only.
 *
 * Never adds an existing account (S-07c, Hein 2026-10-23): every invitee gets
 * a token by email and accepts it at /invite/<token>, which checks that the
 * signed-in session's email is the invitation's. change-email sets an address
 * without proving it is owned, so adding an existing account by address let
 * anyone take the place of whoever a company was about to invite.
 *
 * Runs on the migration_admin pool, as do the other invitation writes in this
 * file: an invitation is honoured by the accept routes on that pool, so a row
 * planted from an app pool (forged claims) would hand out a membership, and
 * no app role may write the table (migration 930). company_invitations_role_guard
 * does not judge this role, so its rules are checked here, against the
 * inviter's membership as it stands: `invitedBy` must be the verified caller.
 */
export async function createInvitation(
  companyId: string,
  email: string,
  role: string,
  invitedBy: string,
): Promise<InvitationResult> {
  if (!isValidRole(role)) {
    throw new Error(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
  }
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashInviteToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const inv = await migrationAdminTx('create invitation', async (client) => {
    await assertCanInvite(client, companyId, invitedBy, role);
    await assertNotMember(client, companyId, email);
    const rows = await client.query(
      `INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at)
       VALUES ($1::UUID, $2, $3, $4, $5, $6::TIMESTAMPTZ)
       ON CONFLICT (company_id, email) DO UPDATE SET
         role = EXCLUDED.role,
         invited_by = EXCLUDED.invited_by,
         token = EXCLUDED.token,
         expires_at = EXCLUDED.expires_at,
         accepted_at = NULL,
         email_sent_at = NULL,
         email_error = NULL,
         created_at = NOW()
       RETURNING *`,
      [companyId, email, role, invitedBy, tokenHash, expiresAt],
    );
    return rows.rows[0] as DbRow;
  });

  log.info('Invitation created', { companyId, email, role }, 'accounting');
  return {
    autoAdded: false,
    invitation: { ...mapInvitation(inv), token: rawToken } as InvitationWithToken,
  };
}

/**
 * company_invitations_role_guard's rules for app_user (883/886), for a write
 * on the migration_admin pool, which the guard does not judge: the inviter is
 * an owner or admin of the company now, and only an owner invites an owner.
 * Takes the inviter's membership row lock, so a concurrent demotion is judged
 * before or after this write, not during it.
 */
export async function assertCanInvite(
  client: PoolClient, companyId: string, invitedBy: string, role: string,
): Promise<void> {
  const actor = await client.query<{ role: string }>(
    `SELECT role FROM company_users WHERE company_id = $1::UUID AND user_id::TEXT = $2 FOR SHARE`,
    [companyId, invitedBy],
  );
  const actorRole = actor.rows[0]?.role;
  if (actorRole !== 'owner' && actorRole !== 'admin') {
    throw new InvitationForbiddenError('Only owners and admins can invite users.');
  }
  const owner = await client.query<{ owner: boolean }>(
    'SELECT public.company_member_role_is_owner($1) AS owner', [role],
  );
  if (owner.rows[0]?.owner && actorRole !== 'owner') {
    throw new InvitationForbiddenError('Only an owner can grant the owner role.');
  }
}

/**
 * Refuses an address that already belongs to a member of the company. Run
 * after assertCanInvite, so only an owner or admin learns the answer, which
 * the members screen shows them anyway.
 */
export async function assertNotMember(client: PoolClient, companyId: string, email: string): Promise<void> {
  const member = await client.query(
    `SELECT 1 FROM company_users cu JOIN users u ON u.id::TEXT = cu.user_id::TEXT
      WHERE cu.company_id = $1::UUID AND lower(u.email) = lower($2) LIMIT 1`,
    [companyId, email],
  );
  if ((member.rowCount ?? 0) > 0) throw new InvitationConflictError('This user is already a member of the company.');
}

/** The address is already a member's (see assertNotMember): a 409. */
export class InvitationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvitationConflictError';
  }
}

/** The inviter may not write this invitation (see assertCanInvite). */
export class InvitationForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvitationForbiddenError';
  }
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

// The send status, on the same pool as the invitation it describes: no app
// role may UPDATE company_invitations (migration 930). Through migrationAdminTx
// so the change log names the sender, as for every write to a tracked table.
export async function markInvitationEmailSent(invitationId: string, companyId: string): Promise<void> {
  await migrationAdminTx('invitation email sent', (client) => client.query(
    `UPDATE company_invitations SET email_sent_at = NOW(), email_error = NULL
      WHERE id = $1::UUID AND company_id = $2::UUID`,
    [invitationId, companyId],
  ));
}

export async function markInvitationEmailFailed(invitationId: string, companyId: string, error: string): Promise<void> {
  await migrationAdminTx('invitation email failed', (client) => client.query(
    'UPDATE company_invitations SET email_error = $3 WHERE id = $1::UUID AND company_id = $2::UUID',
    [invitationId, companyId, error],
  ));
}

export async function cancelInvitation(invitationId: string, companyId: string): Promise<void> {
  await sql`
    DELETE FROM company_invitations
    WHERE id = ${invitationId}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Invitation cancelled', { invitationId, companyId }, 'accounting');
}
