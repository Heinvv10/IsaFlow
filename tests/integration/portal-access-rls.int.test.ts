// tests/integration/portal-access-rls.int.test.ts
//
// Migration 977: portal_access (an AR portal login) is under FORCE RLS with the
// active-company tenant_isolation policy, on the logins production has.
//   - in a request (app_user), a company reads and removes only its own logins,
//     even when the user is a member of the other company too;
//   - the pre-tenant session check (portalSession.ts, bare `sql` on the
//     isaflow_service pool) still finds a live login through app_service's
//     mirror, and refuses a deactivated one;
//   - the marked rollback SQL runs.
// Real PostgreSQL; synthetic rows only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { attempt, fixture, migration, newIds, rolledBack, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const { owner, me, company, other } = ids;
const mine = { customer: crypto.randomUUID(), login: crypto.randomUUID(), email: `pa-mine-${crypto.randomUUID()}@test.local` };
const theirs = { customer: crypto.randomUUID(), login: crypto.randomUUID(), email: `pa-other-${crypto.randomUUID()}@test.local` };
const MIGRATION = '977_portal_access_rls.sql';

beforeAll(async () => {
  await setup(ids);
  for (const [row, companyId] of [[mine, company], [theirs, other]] as const) {
    await fixture.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Portal RLS customer')`, [row.customer, companyId]);
    await fixture.query(`INSERT INTO portal_access (id, client_id, company_id, email, password_hash, name, is_active)
      VALUES ($1, $2, $3, $4, '$2a$12$unused', 'Portal RLS login', true)`, [row.login, row.customer, companyId, row.email]);
  }
}, 60000);

afterAll(async () => {
  try {
    await fixture.query('DELETE FROM portal_access WHERE id = ANY($1)', [[mine.login, theirs.login]]);
  } finally {
    await teardown(ids, [getAuthPool(), getDbPool()]);
  }
});

/** Run `body` as a request would: app_user, the user's claims, the active company. Always rolled back. */
async function asRequest<T>(sub: string, companyId: string, body: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAuthPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub })]);
    await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
    return await body(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release(true);
  }
}

const READ = 'SELECT id FROM portal_access WHERE id = ANY($1) ORDER BY id';
const both = () => [[mine.login, theirs.login]];

describe('977: portal_access is under FORCE RLS', () => {
  it('has RLS forced and exactly the tenant policy plus app_service\'s select and delete mirrors', async () => {
    const rel = await fixture.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.portal_access'::regclass`);
    expect(rel.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await fixture.query(`SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'portal_access' ORDER BY policyname`);
    expect(pol.rows).toEqual([
      { policyname: 'app_service_delete', cmd: 'DELETE', roles: ['app_service'] },
      { policyname: 'app_service_select', cmd: 'SELECT', roles: ['app_service'] },
      { policyname: 'tenant_isolation', cmd: 'ALL', roles: ['app_user'] },
    ]);
  });

  it('a request reads its own company\'s login only', async () => {
    const rows = await asRequest(owner, company, async (c) => (await c.query(READ, both())).rows);
    expect(rows).toEqual([{ id: mine.login }]);
  });

  it('a request cannot read another company\'s login by its customer', async () => {
    const rows = await asRequest(owner, company, async (c) =>
      (await c.query('SELECT id, email FROM portal_access WHERE client_id = $1', [theirs.customer])).rows);
    expect(rows).toEqual([]);
  });

  it('a request cannot delete another company\'s login, and the row survives', async () => {
    const count = await asRequest(owner, company, async (c) =>
      (await c.query('DELETE FROM portal_access WHERE client_id = $1', [theirs.customer])).rowCount);
    expect(count).toBe(0);
    expect((await fixture.query('SELECT 1 FROM portal_access WHERE id = $1', [theirs.login])).rowCount).toBe(1);
  });

  it('a request may still delete its own company\'s login (customer merge)', async () => {
    const count = await asRequest(owner, company, async (c) =>
      (await c.query('DELETE FROM portal_access WHERE client_id = $1', [mine.customer])).rowCount);
    expect(count).toBe(1);
  });

  it('a request cannot insert a login (no INSERT privilege, before RLS)', async () => {
    expect(await attempt(getAuthPool(), [[`INSERT INTO portal_access (client_id, company_id, email, password_hash, name)
      VALUES ($1, $2, 'forged@evil.test', 'x', 'Forged')`, [theirs.customer, other]]], { asRequest: { sub: owner, companyId: company } }))
      .toEqual({ code: '42501', message: 'permission denied for table portal_access' });
  });

  it('a member of both companies sees only the active company\'s login', async () => {
    await fixture.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', false)`, [other, me]);
    try {
      const inMine = await asRequest(me, company, async (c) => (await c.query(READ, both())).rows);
      const inOther = await asRequest(me, other, async (c) => (await c.query(READ, both())).rows);
      expect(inMine).toEqual([{ id: mine.login }]);
      expect(inOther).toEqual([{ id: theirs.login }]);
    } finally {
      await fixture.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [other, me]);
    }
  });

  it('a request whose active company the user is not a member of sees nothing', async () => {
    const rows = await asRequest(owner, other, async (c) => (await c.query(READ, both())).rows);
    expect(rows).toEqual([]);
  });
});

/** portalSession.ts's resolvePortalSession query, verbatim, on the service pool with no claims. */
async function portalSessionRows(pool: Pool, row: typeof mine, companyId: string): Promise<number> {
  const r = await pool.query(`
    SELECT 1
    FROM portal_access pa
    JOIN customers c ON c.id = pa.client_id
    WHERE pa.client_id::TEXT = $1
      AND pa.email = $2
      AND pa.is_active = true
      AND c.company_id::TEXT = $3
      AND pa.company_id = c.company_id
      AND c.deleted_at IS NULL
    LIMIT 1`, [row.customer, row.email, companyId]);
  return r.rowCount ?? 0;
}

describe('977: the pre-tenant portal session check (portalSession.ts)', () => {
  it('runs as isaflow_service', async () => {
    expect((await getDbPool().query('SELECT session_user::text AS u')).rows[0]).toEqual({ u: 'isaflow_service' });
  });

  it('finds a live login with no tenant context, and refuses it once deactivated', async () => {
    expect(await portalSessionRows(getDbPool(), theirs, other)).toBe(1);
    await fixture.query('UPDATE portal_access SET is_active = false WHERE id = $1', [theirs.login]);
    try {
      expect(await portalSessionRows(getDbPool(), theirs, other)).toBe(0);
    } finally {
      await fixture.query('UPDATE portal_access SET is_active = true WHERE id = $1', [theirs.login]);
    }
  });

  it('refuses a token naming the wrong company', async () => {
    expect(await portalSessionRows(getDbPool(), theirs, company)).toBe(0);
  });
});

describe('977: rollback', () => {
  it('the marked rollback SQL runs and leaves portal_access out of RLS', async () => {
    const marked = /^-- ROLLBACK SQL BEGIN$([\s\S]*?)^-- ROLLBACK SQL END$/m.exec(migration(MIGRATION))?.[1];
    if (!marked) throw new Error(`migration ${MIGRATION} must carry executable rollback SQL markers`);
    const down = marked.split('\n').map((line) => line.replace(/^-- ?/, '')).join('\n');
    let after: unknown;
    await rolledBack(async (q) => {
      await q(down);
      after = (await q(`SELECT relrowsecurity, relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'portal_access') AS policies
        FROM pg_class WHERE oid = 'public.portal_access'::regclass`) as { rows: unknown[] }).rows[0];
    });
    expect(after).toEqual({ relrowsecurity: false, relforcerowsecurity: false, policies: 0 });
  });
});
