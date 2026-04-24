// pages/api/auth/register.ts
import type { NextApiHandler } from 'next';
import pg from 'pg';
import { adminCreateUser, signIn } from '@/lib/auth/gotrue';
import { setAuthCookies, setActiveCompanyCookie } from '@/lib/auth/cookies';
import { withRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';

function adminPool(): pg.Pool {
  const url = process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_ADMIN_DATABASE_URL required for register');
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
  const { email, password, firstName, lastName, companyName } = req.body ?? {};
  for (const [name, v] of [['email', email], ['password', password], ['companyName', companyName]] as const) {
    if (typeof v !== 'string' || v.trim().length < 2) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: `${name} required` } });
    }
  }
  if ((password as string).length < 10) {
    return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 10 characters' } });
  }

  const cleanEmail = (email as string).toLowerCase().trim();

  // 1. Create GoTrue user
  const gotrueUser = await adminCreateUser({
    email: cleanEmail,
    password: password as string,
    email_confirm: true,
  });

  // 2. Bootstrap tx: create company + owner membership + profile shadow
  const admin = adminPool();
  const client = await admin.connect();
  let newCompanyId = '';
  try {
    await client.query('BEGIN');
    const company = await client.query<{ id: string }>(
      `INSERT INTO companies (name, is_active) VALUES ($1, true) RETURNING id`,
      [companyName]
    );
    newCompanyId = company.rows[0]!.id;
    await client.query(
      `INSERT INTO company_users (company_id, user_id, role, is_default)
       VALUES ($1::uuid, $2, 'owner', true)`,
      [newCompanyId, gotrueUser.id]
    );
    await client.query(
      `INSERT INTO users (id, email, first_name, last_name, is_active, role)
       VALUES ($1, $2, $3, $4, true, 'admin')
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      [gotrueUser.id, cleanEmail, firstName ?? null, lastName ?? null]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Clean up the GoTrue user so the email isn't stuck in a half-created state
    log.warn('register rollback', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
    throw err;
  } finally {
    client.release();
    await admin.end();
  }

  // 3. Sign in to get tokens
  const tok = await signIn(cleanEmail, password as string);
  setAuthCookies(res, {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresIn: tok.expires_in,
  });
  setActiveCompanyCookie(res, newCompanyId);

  return res.status(201).json({
    success: true,
    data: { userId: gotrueUser.id, companyId: newCompanyId },
  });
};

export default withRateLimit(handler, { max: 5, windowSecs: 3600 });
