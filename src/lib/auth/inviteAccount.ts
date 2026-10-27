// src/lib/auth/inviteAccount.ts
import type pg from 'pg';
import { adminCreateUser } from './gotrue';

/**
 * The GoTrue account an invitation is accepted as.
 *
 * POST /api/invitations creates (or finds) that account when it sends the
 * invite and stores it in `gotrue_user_id`. userInvitationService — the
 * Settings → User Access screen — never did, so its invitees had no way to
 * set a password and join: /accept-invite refused the row and the only other
 * route was the self-serve signup, which creates a SECOND company.
 *
 * Resolved here instead, at accept time, the same way the invite path does:
 * adminCreateUser answers an existing address with that existing user (422 →
 * lookup), so an address that already has a login gets that login, and the
 * caller's established-account check then demands its current password. The
 * id is written back with COALESCE so concurrent accepts, and a later revoke
 * (pages/api/invitations/revoke/[id].ts), all see one account.
 *
 * `client` is the migration_admin connection the accept handler already holds,
 * outside any transaction, so the link survives a later failed accept and a
 * revoke can still clean the account up.
 */
export async function resolveInvitationAccount(
  client: pg.PoolClient,
  inv: { id: string; email: string; gotrue_user_id: string | null },
): Promise<string> {
  if (inv.gotrue_user_id) return inv.gotrue_user_id;
  const account = await adminCreateUser({ email: inv.email, email_confirm: true });
  const { rows } = await client.query<{ gotrue_user_id: string }>(
    `UPDATE company_invitations SET gotrue_user_id = COALESCE(gotrue_user_id, $2::uuid)
      WHERE id = $1::uuid RETURNING gotrue_user_id`,
    [inv.id, account.id],
  );
  return rows[0]?.gotrue_user_id ?? account.id;
}
