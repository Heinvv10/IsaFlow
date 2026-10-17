/**
 * Shared fixture for the onboarding complete-setup suites: a signed-in user who
 * already belongs to one company (the active-company cookie withAuth needs),
 * a caller for the REAL route (withAuth + withErrorHandler + withCsrf), tiny
 * files whose magic bytes pass fileMagic, and the row counts the suites assert.
 * All values are synthetic.
 */
import type { Pool } from 'pg';
import completeSetup from '../../../pages/api/onboarding/complete-setup';
import { request, response } from '../mfa-impersonation-postgres.helpers';
import { signSession } from '../r-032-fake-gotrue.helpers';

// 2 KB each: complete-setup refuses an upload under 1 KB (uploadLimits.MIN_UPLOAD_BYTES).
const pad = (head: Buffer) => Buffer.concat([head, Buffer.alloc(2048 - head.length, 0x20)]);
/** A distinct 2 KB PNG per person: the same ID document twice is refused as the same person. */
export const pngFor = (seed: string) => `data:image/png;base64,${pad(Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)])).toString('base64')}`;
export const PDF = `data:application/pdf;base64,${pad(Buffer.from('%PDF-1.4\n% synthetic onboarding fixture\n')).toString('base64')}`;
export const PNG = `data:image/png;base64,${pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).toString('base64')}`;

export const doc = (type: string) => ({ type, name: `${type}.pdf`, data: PDF, mimeType: 'application/pdf', size: 2048 });
export const person = (name: string, withId = true) => ({
  name, idNumber: `SYNTH-ID-${name}`, ...(withId ? { idDocument: { name: `${name}-id.png`, data: pngFor(name) } } : {}),
});

export interface SetupUser { userId: string; homeCompanyId: string; token: string }

export async function newSetupUser(pool: Pool): Promise<SetupUser> {
  const userId = crypto.randomUUID();
  const homeCompanyId = crypto.randomUUID();
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [homeCompanyId, `WIZ home ${homeCompanyId}`]);
  await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'admin', true, false)`,
    [userId, `${userId}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', true)`,
    [homeCompanyId, userId]);
  return { userId, homeCompanyId, token: await signSession(userId, undefined, 'aal2') };
}

export function setupBody(entityType: string, over: Record<string, unknown> = {}) {
  return {
    requestKey: crypto.randomUUID(), entityType, coaTemplate: 'isaflow_standard',
    company: { name: `WIZ ${entityType} ${crypto.randomUUID()}`, vatPeriod: 'none', financialYearStart: 3 },
    people: [], documents: [], ...over,
  };
}

export interface SetupCall { status: number; body: { data?: { companyId?: string; replayed?: boolean }; error?: { message?: string } }; cookies: string[] }

export async function callSetup(u: SetupUser, body: unknown): Promise<SetupCall> {
  return callRoute(completeSetup, u, body, '/api/onboarding/complete-setup');
}

/** Any withAuth route, as `u` in their home company (CSRF cookie + header set). */
export async function callRoute(route: unknown, u: SetupUser, body: unknown, url: string, method = 'POST'): Promise<SetupCall> {
  const req = request({ 'sb-access-token': u.token, active_company_id: u.homeCompanyId }, method) as unknown as
    { body: unknown; url: string; query: unknown };
  req.body = body;
  req.url = url;
  req.query = {};
  const out = response();
  await (route as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return {
    status: out.state.statusCode,
    body: (out.state.body ?? {}) as SetupCall['body'],
    cookies: (out.headers.get('set-cookie') as string[] | undefined) ?? [],
  };
}

/** Rows that would be left behind for a company id, per table. */
export async function rowsFor(pool: Pool, companyId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [table, col] of [['companies', 'id'], ['company_users', 'company_id'], ['company_directors', 'company_id'],
    ['company_documents', 'company_id'], ['gl_accounts', 'company_id'], ['fiscal_periods', 'company_id']] as const) {
    out[table] = (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} = $1`, [companyId])).rows[0].n;
  }
  return out;
}

export const NO_ROWS = {
  companies: 0, company_users: 0, company_directors: 0, company_documents: 0, gl_accounts: 0, fiscal_periods: 0,
};

/** Everything the suite created: the companies the users belong to, the users, their rate-limit buckets. */
export async function dropSetupUsers(pool: Pool, users: SetupUser[]): Promise<void> {
  for (const u of users) {
    const owned = (await pool.query('SELECT company_id FROM company_users WHERE user_id = $1', [u.userId])).rows
      .map((r: { company_id: string }) => r.company_id);
    for (const id of new Set([...owned, u.homeCompanyId])) {
      // fiscal_periods and gl_accounts (create_company_with_owner's taxonomy) do not cascade with the company.
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [id]);
      for (const t of ['gl_accounts', 'fiscal_periods']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [id]);
      await pool.query('DELETE FROM companies WHERE id = $1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [u.userId]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', [`%${u.userId}%`]);
  }
}
