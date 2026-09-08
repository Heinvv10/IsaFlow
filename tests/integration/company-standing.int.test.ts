import { createHash } from 'crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { withAuth } from '@/lib/auth/withAuth';
import { withBearerAuth } from '@/lib/auth/withBearerAuth';
import { registerOauthApp } from '@/lib/auth/oauth';
import { createPat } from '@/lib/auth/personalAccessTokens';
import { suspendCompany, activateCompany, deleteCompany } from '@/modules/admin/services/adminCompanyService';
import { mintPrintToken } from '@/lib/pdf/printAuth';
import { sql } from '@/lib/neon';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const userId = crypto.randomUUID();
const companyId = crypto.randomUUID();
const otherCompanyId = crypto.randomUUID();
let printToken: string;
let cookieToken: string;
let patToken: string;
const oauthToken = `oat_${crypto.randomUUID().replaceAll('-', '')}`;
let oauthAppId: string | undefined;

beforeAll(async () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Disposable JWT_SECRET required');
  vi.stubEnv('PRINT_TOKEN_SECRET', 'disposable-company-standing-print-secret');
  printToken = mintPrintToken(companyId, userId, ['/api/accounting/mfa-integration-fixture']);
  await pool.query('INSERT INTO users (id,email,role,is_active) VALUES ($1,$2,$3,true)',
    [userId, `company-standing-${userId}@test.local`, 'viewer']);
  await pool.query('INSERT INTO companies (id,name) VALUES ($1,$2),($3,$4)',
    [companyId, `Standing ${companyId}`, otherCompanyId, `Other ${otherCompanyId}`]);
  await pool.query(`INSERT INTO company_users (company_id,user_id,role) VALUES
    ($1,$2,'admin'),($3,$2,'admin')`, [companyId, userId, otherCompanyId]);
  cookieToken = await new SignJWT({ sub: userId, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  oauthAppId = (await registerOauthApp({ ownerUserId: userId, name: 'standing fixture', redirectUris: ['http://localhost/callback'] })).id;
  await pool.query(`INSERT INTO oauth_authorisations
    (oauth_app_id,user_id,company_id,scopes,access_token_hash,access_token_expires_at)
    VALUES ($1,$2,$3,$4,$5,NOW()+INTERVAL '1 hour')`,
    [oauthAppId,userId,companyId,['read:invoices'],createHash('sha256').update(oauthToken).digest('hex')]);
  patToken = (await createPat({ userId, companyId, name: 'standing fixture', scopes: ['read:invoices'], expiresInDays: 1 })).raw;
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM oauth_authorisations WHERE company_id=$1 AND user_id=$2', [companyId,userId]);
    await pool.query('DELETE FROM oauth_apps WHERE id=$1 AND owner_user_id=$2', [oauthAppId,userId]);
    await pool.query('DELETE FROM personal_access_tokens WHERE company_id=$1 AND user_id=$2', [companyId, userId]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[]) AND user_id=$2', [[companyId, otherCompanyId], userId]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[companyId, otherCompanyId]]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  } finally {
    await pool.end();
    vi.unstubAllEnvs();
  }
});

for (const method of ['cookie', 'pat', 'oauth', 'print'] as const) {
  for (const standing of ['suspended', 'deleted', 'suspension-marker'] as const) {
    it(`${method}: existing credentials denied after company ${standing}; another tenant and reactivation work`, async () => {
      await activateCompany(companyId);
      let calls = 0;
      const handler = async (_req: unknown, res: Parameters<ReturnType<typeof withAuth>>[1]) => {
        calls++;
        const rows = await sql<{ id: string }>`SELECT id FROM companies WHERE id=${companyId}::uuid`;
        expect(rows).toEqual([{ id: companyId }]);
        res.status(200).json({ ok: true });
      };
      const wrapped = (method === 'cookie' || method === 'print') ? withAuth(handler) : withBearerAuth(handler);
      const req = () => {
        const value = request({ 'sb-access-token': method === 'print' ? printToken : cookieToken, active_company_id: companyId }, 'GET');
        if (method === 'pat' || method === 'oauth') value.headers.authorization = `Bearer ${method === 'pat' ? patToken : oauthToken}`;
        return value;
      };
      const before = response();
      await wrapped(req(), before.res);
      expect(before.state.statusCode).toBe(200);
      expect(calls).toBe(1);
      if (standing === 'suspended') await suspendCompany(companyId, 'disposable regression');
      else if (standing === 'deleted') await deleteCompany(companyId);
      else await pool.query('UPDATE companies SET suspended_at=NOW() WHERE id=$1', [companyId]);
      const denied = response();
      await wrapped(req(), denied.res);
      expect(denied.state.statusCode).toBe(403);
      expect(calls).toBe(1);
      // Suspension is tenant-specific; the same user can still enter another company.
      const other = response();
      await withAuth(async (_req, res) => { res.status(200).json({ ok: true }); })(
        request({ 'sb-access-token': cookieToken, active_company_id: otherCompanyId }, 'GET'), other.res);
      expect(other.state.statusCode).toBe(200);
      await activateCompany(companyId);
      const restored = response();
      await wrapped(req(), restored.res);
      expect(restored.state.statusCode).toBe(200);
      expect(calls).toBe(2);
    });
  }
}
