/**
 * PR #1405 review + breaker round (WP14b): the caller's malformed input is a 400 naming what was wrong, never a 500
 * from a Postgres cast, CHECK or foreign key, and nothing is written. Real admin stack on the disposable fixture.
 *
 *   - companies/[id]/features POST/DELETE: feature_id is a UUID (a bare string reached the uuid column as 22P02);
 *   - announcements POST/PATCH: target_ids are UUIDs, type/target are the CHECK constraint's values, and starts_at /
 *     ends_at are real ISO instants (Date.parse also read JS Date strings, "+275760-..." and "2026-02-30");
 *   - webhooks GET: page=abc / companyId=x are 400s (a catch-all around the validators made them 500s);
 *   - sars-codes GET: taxYear outside 2000..2100 is a 400 (3000000000 overflowed int4 as a 500);
 *   - any admin route: a repeated query parameter or one holding a NUL byte is a 400 before any SQL;
 *   - refusals that already were right stay right (missing SARS release year, missing user / company / bureau user).
 * Tokens are aal2; GoTrue is not called. Disposable fixture only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import companyFeaturesRoute from '../../pages/api/admin/companies/[id]/features';
import announcementRoute from '../../pages/api/admin/announcements/[id]';
import announcementsRoute from '../../pages/api/admin/announcements';
import webhooksRoute from '../../pages/api/admin/webhooks';
import sarsIndexRoute from '../../pages/api/admin/payroll/sars-codes/index';
import sarsReleaseRoute from '../../pages/api/admin/payroll/sars-codes/release';
import companiesRoute from '../../pages/api/admin/companies';
import companyRoute from '../../pages/api/admin/companies/[id]';
import userRoute from '../../pages/api/admin/users/[id]';
import bureauRoute from '../../pages/api/admin/users/[id]/convert-to-bureau';
import auditRoute from '../../pages/api/admin/audit';
import emailLogRoute from '../../pages/api/admin/email-log';
import usersRoute from '../../pages/api/admin/users';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const admin = crypto.randomUUID();
const otherSuper = crypto.randomUUID();
const company = crypto.randomUUID();
const TAG = `wp14b-in-${Date.now()}`;
let ann = '';
let insertedRelease = false;

type Route = (req: never, res: never) => Promise<unknown>;
type Body = { success?: boolean; error?: { code?: string; message?: string } };
async function call(route: unknown, method: string, query: Record<string, unknown>, body?: unknown) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method) as unknown as { body: unknown; url: string; query: Record<string, unknown> };
  req.query = query;
  req.body = body;
  req.url = '/api/admin/x';
  const result = response();
  await (route as Route)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as Body };
}
const n = async (text: string, params: unknown[]) => (await pool.query(text, params)).rows[0].n as number;
const auditRows = (targetId: string) => n('SELECT count(*)::int n FROM admin_audit_log WHERE target_id = $1', [targetId]);
const announcementCount = () => n('SELECT count(*)::int n FROM system_announcements WHERE title LIKE $1', [`${TAG}%`]);

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true), ($3, $4, 'super_admin', true)`,
    [admin, `${admin}@test.local`, otherSuper, `${otherSuper}@test.local`]);
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [company, `${TAG} co`]);
  ann = (await pool.query(`INSERT INTO system_announcements (title, message, starts_at, created_by) VALUES ($1, 'm', now(), $2) RETURNING id`,
    [`${TAG} ann`, admin])).rows[0].id;
  // A current release the refused one must not displace (only when the fixture has none: never disturb another's).
  insertedRelease = (await pool.query(`INSERT INTO sars_code_releases (effective_year, brs_version, released_at, is_current)
    SELECT 2091, $1, now(), true WHERE NOT EXISTS (SELECT 1 FROM sars_code_releases WHERE is_current OR effective_year = 2091)
    RETURNING effective_year`, [TAG])).rowCount === 1;
}, 60000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM system_announcements WHERE title LIKE $1', [`${TAG}%`]);
    if (insertedRelease) await pool.query('DELETE FROM sars_code_releases WHERE effective_year = 2091 AND brs_version = $1', [TAG]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [admin, otherSuper]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally { await pool.end(); }
});

describe('companies/[id]/features: feature_id is a UUID', () => {
  it.each(['POST', 'DELETE'])('%s with feature_id "x" is a 400 naming feature_id', async (method) => {
    const body = method === 'POST' ? { feature_id: 'x', enabled: true, reason: 'r' } : { feature_id: 'x' };
    const r = await call(companyFeaturesRoute, method, { id: company }, body);
    expect(r.status).toBe(400);
    expect(await auditRows(company)).toBe(0);
  });

  it('POST naming a missing feature UUID: 404, no override, no audit row', async () => {
    const r = await call(companyFeaturesRoute, 'POST', { id: company }, { feature_id: crypto.randomUUID(), enabled: true, reason: 'r' });
    expect(r.status).toBe(404);
    expect(await n('SELECT count(*)::int n FROM company_feature_overrides WHERE company_id = $1', [company])).toBe(0);
    expect(await auditRows(company)).toBe(0);
  });
});

describe('announcements: ids, enums and instants are checked before the write', () => {
  it.each([
    ['target_ids not UUIDs', { target_ids: ['x'] }],
    ['an unknown type', { type: 'bogus' }],
    ['an unknown target', { target: 'everyone' }],
    ['a JS Date string start', { starts_at: 'Sun Nov 15 2026 10:00:00 GMT+0200 (South Africa Standard Time)' }],
    ['a start on 30 February', { starts_at: '2026-02-30T08:00:00.000Z' }],
    ['a six-digit-year start', { starts_at: '+275760-09-13T00:00:00.000Z' }],
    ['a JS Date string end', { ends_at: 'Mon Nov 16 2026 10:00:00 GMT+0200' }],
  ])('PATCH with %s: 400, nothing changed', async (_name, body) => {
    const before = (await pool.query('SELECT * FROM system_announcements WHERE id = $1', [ann])).rows[0];
    const r = await call(announcementRoute, 'PATCH', { id: ann }, body);
    expect(r.status).toBe(400);
    expect((await pool.query('SELECT * FROM system_announcements WHERE id = $1', [ann])).rows[0]).toEqual(before);
    expect(await auditRows(ann)).toBe(0);
  });

  it.each([
    ['a JS Date string start', { starts_at: 'Sun Nov 15 2026 10:00:00 GMT+0200 (South Africa Standard Time)' }],
    ['a start on 30 February', { starts_at: '2026-02-30T08:00:00.000Z' }],
    ['a six-digit-year start', { starts_at: '+275760-09-13T00:00:00.000Z' }],
    ['target_ids not UUIDs', { starts_at: '2026-11-20T08:00:00.000Z', target: 'company', target_ids: ['x'] }],
    ['an unknown type', { starts_at: '2026-11-20T08:00:00.000Z', type: 'bogus' }],
  ])('POST with %s: 400, no row', async (_name, body) => {
    const before = await announcementCount();
    const r = await call(announcementsRoute, 'POST', {}, { title: `${TAG} post`, message: 'm', ...body });
    expect(r.status).toBe(400);
    expect(await announcementCount()).toBe(before);
  });

  it('the form\'s own shape still saves: ISO instants, company UUID targets', async () => {
    const r = await call(announcementsRoute, 'POST', {}, { title: `${TAG} ok`, message: 'm', type: 'warning',
      target: 'company', target_ids: [company], starts_at: '2026-11-20T06:00:00.000Z', ends_at: '2026-11-21T06:00:00.000Z' });
    expect(r.status).toBe(200);
  });
});

describe('query parameters are checked before any SQL', () => {
  it.each([
    ['webhooks page=abc', webhooksRoute, { page: 'abc' }, /page/],
    ['webhooks companyId=x', webhooksRoute, { companyId: 'x' }, /companyId/],
    ['sars-codes taxYear=3000000000', sarsIndexRoute, { taxYear: '3000000000' }, /taxYear/],
    ['sars-codes taxYear=1999', sarsIndexRoute, { taxYear: '1999' }, /taxYear/],
    ['sars-codes taxYear=2101', sarsIndexRoute, { taxYear: '2101' }, /taxYear/],
    ['sars-codes search repeated', sarsIndexRoute, { taxYear: '2091', search: ['a', 'b'] }, /search.*once/],
    ['companies sort_by repeated', companiesRoute, { sort_by: ['name', 'name'] }, /sort_by.*once/],
    ['users sort_dir repeated', usersRoute, { sort_dir: ['asc', 'asc'] }, /sort_dir.*once/],
    ['audit source repeated', auditRoute, { source: ['admin', 'auth'] }, /source.*once/],
    ['companies search with a NUL', companiesRoute, { search: 'a\u0000b' }, /search.*NUL/],
    ['users search with a NUL', usersRoute, { search: 'a\u0000b' }, /search.*NUL/],
    ['audit user_id with a NUL', auditRoute, { user_id: 'a\u0000b' }, /user_id.*NUL/],
    ['email-log email_type with a NUL', emailLogRoute, { email_type: 'a\u0000b' }, /email_type.*NUL/],
  ])('%s: 400 naming it', async (_name, route, query, named) => {
    const r = await call(route, 'GET', query);
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(named);
  });

  it('valid parameters still answer 200', async () => {
    expect((await call(webhooksRoute, 'GET', { page: '1', limit: '5' })).status).toBe(200);
    expect((await call(sarsIndexRoute, 'GET', { taxYear: '2026' })).status).toBe(200);
  });
});

describe('refusals that write nothing', () => {
  it('releasing a SARS year with no codes: 404, the current release untouched, no audit row', async () => {
    const current = (await pool.query('SELECT effective_year FROM sars_code_releases WHERE is_current ORDER BY effective_year')).rows;
    expect(current.length).toBeGreaterThan(0);
    const r = await call(sarsReleaseRoute, 'POST', {}, { taxYear: 2099 });
    expect(r.status).toBe(404);
    expect((await pool.query('SELECT effective_year FROM sars_code_releases WHERE is_current ORDER BY effective_year')).rows).toEqual(current);
    expect(await auditRows('2099')).toBe(0);
  });

  it('companies/[id] PATCH on a missing company: 404, no audit row', async () => {
    const id = crypto.randomUUID();
    expect((await call(companyRoute, 'PATCH', { id }, { name: 'ghost' })).status).toBe(404);
    expect(await auditRows(id)).toBe(0);
  });

  it('users/[id] PATCH / DELETE on a missing user: 404; DELETE of a super admin: 403; no audit rows', async () => {
    const ghost = `ghost-${TAG}`;
    expect((await call(userRoute, 'PATCH', { id: ghost }, { first_name: 'x' })).status).toBe(404);
    expect((await call(userRoute, 'DELETE', { id: ghost })).status).toBe(404);
    expect((await call(userRoute, 'DELETE', { id: otherSuper })).status).toBe(403);
    expect(await n('SELECT count(*)::int n FROM users WHERE id = $1', [otherSuper])).toBe(1);
    expect(await auditRows(ghost)).toBe(0);
    expect(await auditRows(otherSuper)).toBe(0);
  });

  it('convert-to-bureau for a missing user: 404, no bureau, no audit row', async () => {
    const ghost = `ghost-bureau-${TAG}`;
    expect((await call(bureauRoute, 'POST', { id: ghost }, { bureauName: 'B' })).status).toBe(404);
    expect(await n('SELECT count(*)::int n FROM bureaus WHERE owner_user_id = $1', [ghost])).toBe(0);
    expect(await auditRows(ghost)).toBe(0);
  });
});
