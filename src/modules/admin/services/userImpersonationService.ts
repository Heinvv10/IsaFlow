/**
 * User Impersonation — stash helpers.
 * Stores the admin's tokens so "Return to my session" can restore them.
 * All session-minting is handled by GoTrue (admin/generate_link + verify).
 */
import { sql } from '@/lib/neon';

const IMPERSONATION_TTL_HOURS = 1;

export interface StashInput {
  adminUserId: string;
  adminAccessToken: string;
  adminRefreshToken: string;
  targetUserId: string;
}

export interface StashRow {
  stash_id: string;
  admin_user_id: string;
  admin_access_token: string;
  admin_refresh_token: string;
  target_user_id: string;
  expires_at: Date;
}

export async function stashAdminTokens(input: StashInput): Promise<string> {
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_HOURS * 60 * 60 * 1000);
  const rows = await sql<{ stash_id: string }>`
    INSERT INTO admin_impersonation_stash (
      admin_user_id, admin_access_token, admin_refresh_token, target_user_id, expires_at
    ) VALUES (
      ${input.adminUserId}, ${input.adminAccessToken}, ${input.adminRefreshToken},
      ${input.targetUserId}, ${expiresAt.toISOString()}
    )
    RETURNING stash_id
  `;
  return String(rows[0]!.stash_id);
}

export async function loadStash(stashId: string): Promise<StashRow | null> {
  const rows = await sql<StashRow>`
    SELECT stash_id, admin_user_id, admin_access_token, admin_refresh_token, target_user_id, expires_at
    FROM admin_impersonation_stash
    WHERE stash_id = ${stashId}::uuid
      AND expires_at > NOW()
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function deleteStash(stashId: string): Promise<void> {
  await sql`DELETE FROM admin_impersonation_stash WHERE stash_id = ${stashId}::uuid`;
}

export interface TargetValidationResult {
  userId: string;
  email: string;
}

export async function validateImpersonationTarget(targetUserId: string): Promise<TargetValidationResult> {
  const rows = await sql<{ id: string; email: string; role: string; is_active: boolean }>`
    SELECT id, email, role, is_active FROM users WHERE id = ${targetUserId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error('TARGET_NOT_FOUND');
  if (!row.is_active) throw new Error('TARGET_INACTIVE');
  if (row.role === 'super_admin') throw new Error('CANNOT_IMPERSONATE_SUPER_ADMIN');
  return { userId: row.id, email: row.email };
}
