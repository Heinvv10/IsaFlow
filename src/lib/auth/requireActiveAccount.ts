// src/lib/auth/requireActiveAccount.ts
/**
 * Account-standing guard for the auth routes that own a plain `sql` handle
 * rather than a pipeline transaction.
 *
 * withAuth, bearerPipeline and withPlatformAdmin each already fetch a users
 * row inside their own pg client, so they join the standing columns into that
 * query and call `isActiveUserAccount` directly. The routes that mint or renew
 * a session (login, refresh, 2fa-challenge) have no such query — this is their
 * shared lookup, so the standing rule keeps exactly one definition.
 *
 * Returns `null` to allow, or the refusal payload to send with a 403.
 *
 * Deliberately NOT an existence check: registration creates the GoTrue identity
 * before tenantProvisioningService INSERTs into public.users, so a missing row
 * means "not provisioned yet", not "revoked". 58 live GoTrue identities in
 * production currently have no profile row; requiring one would lock them all
 * out of signing in.
 */
import { sql } from '@/lib/neon';
import { isActiveUserAccount, SUSPENDED_ACCOUNT_ERROR, type UserAccountRow } from './userAccountStatus';

export async function requireActiveAccount(
  userId: string,
): Promise<{ code: string; message: string } | null> {
  const rows = await sql<UserAccountRow>`
    SELECT is_active, status, suspended_at
    FROM users
    WHERE id = ${userId}
    LIMIT 1
  `;
  const account = rows[0];
  if (account && !isActiveUserAccount(account)) return { ...SUSPENDED_ACCOUNT_ERROR };
  return null;
}
