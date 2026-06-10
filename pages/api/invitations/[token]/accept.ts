// pages/api/invitations/[token]/accept.ts
import type { NextApiHandler } from 'next';
import pg from 'pg';
import { withInviteToken, type InviteTokenRequest } from '@/lib/auth/withInviteToken';
import { adminUpdateUser, signIn } from '@/lib/auth/gotrue';
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

  // 2. Set the user's password in GoTrue
  await adminUpdateUser(inv.gotrue_user_id, {
    password,
    user_metadata: { first_name: firstName, last_name: lastName },
  });

  // 3. Sign them in to get tokens
  const tok = await signIn(inv.email, password);

  // 4. Insert company_users + users-profile rows using BYPASSRLS admin role
  //    (RLS policy would refuse company_users INSERT because the user has no
  //    pre-existing membership to satisfy USING.)
  const admin = adminPool();
  const client = await admin.connect();
  try {
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
