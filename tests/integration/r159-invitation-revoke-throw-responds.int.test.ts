/**
 * R-159 — invitations/revoke/[id].ts is withAuth(withCsrf(handler)) with no withErrorHandler, so
 * before R-159 every throw in it hung the client: withAuth rolled back and rethrew with res.end
 * still buffered. A throw is forced right after the route's DELETE through a hook on `sql`; the
 * hook is asserted to have fired. Runs as app_user with RLS, through the real route.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import { call } from './r159-auth-wrapper.helpers';

const h = vi.hoisted(() => ({ revokeHookFired: 0 }));
vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const real = original.sql;
  const hooked = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = real(strings, ...values);
    if (!strings.join('$').includes('DELETE FROM company_invitations')) return query;
    return Promise.resolve(query).then(() => {
      h.revokeHookFired += 1;
      throw new Error('R-159 forced failure after the invitation DELETE');
    });
  };
  const sql = Object.assign(hooked, real);
  return { ...original, sql, default: sql };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const CO = randomUUID();
const USER = randomUUID();
let cookieJwt = '';

const cookieReq = () => request({ 'sb-access-token': cookieJwt, active_company_id: CO }, 'POST');

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R159 revoke']);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
    [USER, `r159-revoke-${USER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)",
    [CO, USER]);
  cookieJwt = await new SignJWT({ sub: USER, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    for (const t of ['company_invitations', 'company_users']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [CO]);
    }
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE id = $1', [USER]);
  } finally {
    await pool.end();
  }
});

describe('invitations/revoke/[id] (withAuth, no withErrorHandler)', () => {
  const invite = async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO company_invitations (id, company_id, email, role, invited_by, token, expires_at, gotrue_user_id)
       VALUES ($1, $2, $3, 'viewer', $4, $5, NOW() + INTERVAL '1 day', $6)`,
      [id, CO, `r159-invitee-${id}@isaflow.test`, USER, `r159-${id}`, randomUUID()]);
    return id;
  };

  it('a throw after the DELETE: the invitation survives, 500, end() once, no rethrow', async () => {
    const id = await invite();
    const before = h.revokeHookFired;
    const route = (await import('../../pages/api/invitations/revoke/[id]')).default;
    const r = await call(route as never, { ...cookieReq(), query: { id } });
    expect(h.revokeHookFired).toBe(before + 1);
    expect(Number((await pool.query('SELECT count(*) AS n FROM company_invitations WHERE id = $1', [id])).rows[0].n)).toBe(1);
    expect(r.threw).toBeNull();
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ success: false, data: null, code: 'INTERNAL_SERVER_ERROR' });
    expect(r.ends).toBe(1);
  });

  it('refusals are unchanged: a GET is 405 and deletes nothing', async () => {
    const id = await invite();
    const route = (await import('../../pages/api/invitations/revoke/[id]')).default;
    const r = await call(route as never, { ...cookieReq(), method: 'GET', query: { id } });
    expect(r.status).toBe(405);
    expect(r.ends).toBe(1);
    expect(Number((await pool.query('SELECT count(*) AS n FROM company_invitations WHERE id = $1', [id])).rows[0].n)).toBe(1);
  });
});
