// pages/api/invitations/[token]/accept.ts
import type { NextApiHandler } from 'next';
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool
// in this process. This file builds its own Pool, so it must not depend on
// src/lib/neon.ts having been imported first. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import { withInviteToken, type InviteTokenRequest } from '@/lib/auth/withInviteToken';
import { adminUpdateUser, signIn, type GoTrueTokenResponse } from '@/lib/auth/gotrue';
import { sql } from '@/lib/neon';
import { setAuthCookies, setActiveCompanyCookie } from '@/lib/auth/cookies';
import { log } from '@/lib/logger';

function adminPool(): pg.Pool {
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required for invite accept');
  return new pg.Pool({
    connectionString: url,
    max: 2,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
}

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } });
  }
  const token = (req as InviteTokenRequest).inviteToken;
  const { password, firstName, lastName } = req.body ?? {};
  if (typeof password !== 'string' || password.length < 10) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters' } });
  }

  // 1. Look up invitation (RLS policy invites_by_token permits this)
  const rows = await sql<{
    id: string; email: string; role: string; company_id: string; gotrue_user_id: string;
  }>`
    SELECT id, email, role, company_id, gotrue_user_id
    FROM company_invitations
    WHERE token = ${token} AND accepted_at IS NULL AND expires_at > now()
    LIMIT 1
  `;
  if (rows.length === 0) {
    return res.status(410).json({ success: false, error: { code: 'INVALID_OR_EXPIRED', message: 'Invitation not found, expired, or already accepted' } });
  }
  const inv = rows[0]!;

  // 2-4 run on the BYPASSRLS admin role: RLS would refuse the company_users
  //    INSERT (no pre-existing membership to satisfy USING) and `users` is
  //    readable only by auth.uid(), which is empty inside the invite-token
  //    transaction — so the step-2 lookup below would silently see no rows.
  const admin = adminPool();
  const client = await admin.connect();
  let tok: GoTrueTokenResponse;
  try {
    // 2. Does this address already hold an established IsaFlow login? A `users`
    //    row is written only by tenant provisioning (after email verification)
    //    and by step 4 below, so its presence means a password already exists.
    //    Invites resolve an EXISTING GoTrue user when adminCreateUser 422s
    //    (src/lib/auth/gotrue.ts), so setting a password here would let whoever
    //    holds the invite link replace the credentials of that person's login
    //    for a company they were never invited to.
    const established = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 LIMIT 1`,
      [inv.gotrue_user_id]
    );
    const isEstablished = (established.rowCount ?? 0) > 0;

    if (!isEstablished) {
      // Brand-new invitee: this invitation is what establishes the login, so
      // the password they type becomes their password.
      await adminUpdateUser(inv.gotrue_user_id, {
        password,
        user_metadata: { first_name: firstName, last_name: lastName },
      });
    }

    // 3. Sign in. For an established account this is the ownership proof — the
    //    acceptor must already know that account's current password.
    try {
      tok = await signIn(inv.email, password);
    } catch (err) {
      if (!isEstablished) throw err;
      log.warn('invite accept rejected: wrong password for existing account', {
        inviteId: inv.id,
        companyId: inv.company_id,
      }, 'auth');
      return res.status(401).json({ success: false, error: { code: 'SIGN_IN_REQUIRED', message: 'This email already has an IsaFlow account. Enter that account\'s password to accept the invitation.' } });
    }
    if (tok.user.id !== inv.gotrue_user_id) {
      log.error('invite accept identity mismatch', {
        inviteId: inv.id,
        companyId: inv.company_id,
      }, 'auth');
      return res.status(409).json({ success: false, error: { code: 'IDENTITY_MISMATCH', message: 'Invitation does not match this account' } });
    }

    // 4. Attach the membership + profile row.
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO company_users (company_id, user_id, role)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT DO NOTHING`,
      [inv.company_id, tok.user.id, inv.role]
    );
    await client.query(
      `INSERT INTO users (id, email, first_name, last_name, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email,
         first_name = COALESCE(EXCLUDED.first_name, users.first_name),
         last_name  = COALESCE(EXCLUDED.last_name,  users.last_name)`,
      [tok.user.id, inv.email, firstName ?? null, lastName ?? null]
    );
    await client.query(
      `UPDATE company_invitations SET accepted_at = now() WHERE id = $1::uuid`,
      [inv.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) =>
      log.error(
        'ROLLBACK failed after transaction error',
        { error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr) },
        'auth',
      ),
    );
    throw err;
  } finally {
    client.release();
    await admin.end();
  }

  // 5. Set cookies
  setAuthCookies(res, {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresIn: tok.expires_in,
  });
  setActiveCompanyCookie(res, inv.company_id);

  return res.status(200).json({ success: true, data: { userId: tok.user.id, companyId: inv.company_id } });
};

export default withInviteToken(handler);
