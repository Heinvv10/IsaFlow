/**
 * R-176 fixture for the three deferred-flush wrappers: one company, one member, a PAT, and an
 * extension connection, each with real credentials. Every spec file imports this in its own
 * worker, so the ids are regenerated per file.
 */
import { vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import { signExtensionToken } from '@/lib/auth/extensionJwt';
import { createPat } from '@/lib/auth/personalAccessTokens';

assertDisposable();
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
export const CO = randomUUID();
export const USER = randomUUID();
export const CONN = randomUUID();
const BANK = randomUUID();
export const creds = { cookieJwt: '', pat: '', extToken: '' };

export const cookieReq = (companyId: string = CO) =>
  request({ 'sb-access-token': creds.cookieJwt, active_company_id: companyId }, 'POST');
export const bearerReq = (token: string = creds.pat) => ({ ...cookieReq(), headers: { authorization: `Bearer ${token}` } });
export const extReq = (token: string = creds.extToken) => ({ ...bearerReq(token), query: {} });
export const extTokenFor = (connectionId: string) => signExtensionToken({
  userId: USER, companyId: CO, connectionId, bankId: 'absa', scope: 'bank-feed-ingest',
});

export const customers = async (name: string) =>
  Number((await pool.query('SELECT count(*) AS n FROM customers WHERE company_id = $1 AND name = $2', [CO, name])).rows[0].n);

export async function setupWrapperFixture(label: string): Promise<void> {
  vi.stubEnv('EXTENSION_SIGNING_KEY', `r176-disposable-extension-signing-${randomUUID()}`);
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, label]);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
    [USER, `r176-${USER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)",
    [CO, USER]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, account_subtype, is_active)
     VALUES ($1, $2, '1110', 'R176 Bank', 'asset', 'debit', 'bank', true)`, [BANK, CO]);
  await pool.query(
    `INSERT INTO bank_feed_connections (id, company_id, bank_account_id, provider, status, is_active, config)
     VALUES ($1, $2, $3, 'extension', 'active', true, '{"bankId":"absa"}')`, [CONN, CO, BANK]);
  creds.cookieJwt = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  creds.pat = (await createPat({ userId: USER, companyId: CO, name: 'r176', scopes: ['read:invoices'], expiresInDays: 1 })).raw;
  creds.extToken = await extTokenFor(CONN);
}

export async function teardownWrapperFixture(): Promise<void> {
  try {
    await pool.query('DELETE FROM personal_access_tokens WHERE company_id = $1', [CO]);
    for (const t of ['customers', 'bank_feed_connections', 'gl_accounts', 'company_users']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
  } finally {
    await pool.end();
    vi.unstubAllEnvs();
  }
}
