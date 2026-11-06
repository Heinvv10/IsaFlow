/**
 * User Impersonation — stash helpers.
 * Stores the admin's tokens so "Return to my session" can restore them.
 * All session-minting is handled by GoTrue (admin/generate_link + verify).
 *
 * Pentest L16 / PR-5: admin_access_token and admin_refresh_token are AES-256-GCM
 * encrypted at rest via src/lib/encryption.ts. A DB dump or BYPASSRLS query
 * yields ciphertext, not live GoTrue bearer tokens.
 *
 * The stash is read, written and deleted on the migration_admin pool (S-07c,
 * migration 930): end-impersonation runs on no admin pool, and an app role that
 * could rewrite target_user_id on a live stash would be handed the admin's
 * restored session, so no app role may read or write the table.
 */
import { sql } from '@/lib/neon';
import { encryptToken, decryptToken } from '@/lib/encryption';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';

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
  // Committed on its own, before the admin's transaction: loadStash reads it
  // back on the same pool before the cookies are set (impersonate.ts), and
  // every failure path there deletes it.
  const rows = (await migrationAdminPool().query<{ stash_id: string }>(
    `INSERT INTO admin_impersonation_stash (
       admin_user_id, admin_access_token, admin_refresh_token, target_user_id, expires_at
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING stash_id`,
    [input.adminUserId, encryptToken(input.adminAccessToken), encryptToken(input.adminRefreshToken),
      input.targetUserId, expiresAt.toISOString()],
  )).rows;
  return String(rows[0]!.stash_id);
}

export async function loadStash(stashId: string): Promise<StashRow | null> {
  const rows = (await migrationAdminPool().query<StashRow>(
    `SELECT stash_id, admin_user_id, admin_access_token, admin_refresh_token, target_user_id, expires_at
       FROM admin_impersonation_stash
      WHERE stash_id = $1::uuid
        AND expires_at > NOW()
      LIMIT 1`,
    [stashId],
  )).rows;
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    admin_access_token: decryptToken(row.admin_access_token),
    admin_refresh_token: decryptToken(row.admin_refresh_token),
  };
}

/**
 * For a Login-as that ended without "Return to my session": the parties come from the
 * session record, not from a cookie. Removes the stash the session named and any of
 * theirs already expired, never a newer live one. Returns how many rows went.
 */
export async function deleteEndedStashes(input: {
  adminUserId: string; targetUserId: string; stashId?: string;
}): Promise<number> {
  const { rowCount } = await migrationAdminPool().query(
    `DELETE FROM admin_impersonation_stash
      WHERE admin_user_id = $1 AND target_user_id = $2
        AND (stash_id::text = $3 OR expires_at <= NOW())`,
    [input.adminUserId, input.targetUserId, input.stashId ?? null],
  );
  return rowCount ?? 0;
}

export async function deleteStash(stashId: string): Promise<void> {
  await migrationAdminPool().query('DELETE FROM admin_impersonation_stash WHERE stash_id = $1::uuid', [stashId]);
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
