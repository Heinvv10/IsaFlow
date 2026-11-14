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
import { boundedPoolRead } from '@/lib/auth/boundedPoolRead';
import { log } from '@/lib/logger';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `loadStash` for end-impersonation, which any browser can call with any stash cookie: bounded (boundedPoolRead),
 * so it never holds or waits long for one of the migration_admin pool's few slots. A non-uuid id is null with no
 * query. `gave_up` when it could not answer in time (logged); the caller must not treat that as "no stash".
 */
export async function loadStashBounded(stashId: string): Promise<StashRow | null | 'gave_up'> {
  if (!UUID.test(stashId)) return null;
  let rows: StashRow[];
  try {
    rows = await boundedPoolRead<StashRow>(migrationAdminPool(), 'loadStashBounded',
      `SELECT stash_id, admin_user_id, admin_access_token, admin_refresh_token, target_user_id, expires_at
         FROM admin_impersonation_stash WHERE stash_id = $1::uuid AND expires_at > NOW() LIMIT 1`, [stashId]);
  } catch (err) {
    log.warn('loadStashBounded: stash look-up failed or timed out', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
    return 'gave_up';
  }
  const row = rows[0];
  if (!row) return null;
  return { ...row, admin_access_token: decryptToken(row.admin_access_token), admin_refresh_token: decryptToken(row.admin_refresh_token) };
}

/**
 * Whose stash `stashId` is, expired or not; null when there is no such row (or the id is not a uuid: no query).
 * Decrypts nothing. Bounded (boundedPoolRead): the unauthenticated end paths (Sign Out, a refused Return) call it
 * on every request, and the migration_admin pool is small; `gave_up` when it could not answer in time (logged).
 */
export async function stashPartiesOf(
  stashId: string,
): Promise<{ adminUserId: string; targetUserId: string } | null | 'gave_up'> {
  if (!UUID.test(stashId)) return null;
  try {
    const rows = await boundedPoolRead<{ admin_user_id: string; target_user_id: string }>(migrationAdminPool(),
      'stashPartiesOf', 'SELECT admin_user_id, target_user_id FROM admin_impersonation_stash WHERE stash_id = $1::uuid',
      [stashId]);
    return rows[0] ? { adminUserId: rows[0].admin_user_id, targetUserId: rows[0].target_user_id } : null;
  } catch (err) {
    log.warn('stashPartiesOf: stash look-up failed or timed out', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
    return 'gave_up';
  }
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

/**
 * Removes every expired stash (any admin): loadStash already refuses them, but each row still holds an admin's
 * encrypted tokens. Run opportunistically on the Login-as start and end paths (no timer). Returns how many went.
 */
export async function purgeExpiredStashes(): Promise<number> {
  const { rowCount } = await migrationAdminPool().query('DELETE FROM admin_impersonation_stash WHERE expires_at <= NOW()');
  return rowCount ?? 0;
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
