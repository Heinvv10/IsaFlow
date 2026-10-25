// tests/integration/s07e-auth-sql-qualified.int.test.ts
//
// S-07e: withAuth's membership and standing checks name public.* relations, so
// a temporary table of the same name on the connection cannot answer for them.
// The app logins can no longer create one (945, s07e-billing-temp.int.test.ts);
// this is the second line, shown on a connection that still can (the fixture's
// owner): a suspended company shadowed as active stays refused.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { getCompanyMembership } from '@/lib/auth/companyMembership';
import { isLiveCompanyForUser, listLiveCompanies, listLiveCompanyMemberships } from '@/lib/auth/liveCompanies';
import { als, type RequestContext } from '@/lib/als';
import { fixture } from './s07b-app-pool-login-role.helpers';

const company = crypto.randomUUID();
const user = crypto.randomUUID();

beforeAll(async () => {
  await fixture.query(`INSERT INTO companies (id, name, is_active, status, suspended_at) VALUES ($1, 'S07e suspended', true, 'suspended', NOW())`,
    [company]);
  await fixture.query(`INSERT INTO users (id, email, role, is_active, status) VALUES ($1, $2, 'viewer', true, 'active')`,
    [user, `${user}@test.local`]);
  await fixture.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)`, [company, user]);
});

afterAll(async () => {
  await fixture.query('DELETE FROM company_users WHERE user_id = $1', [user]);
  await fixture.query('DELETE FROM users WHERE id = $1', [user]);
  await fixture.query('DELETE FROM companies WHERE id = $1', [company]);
  await fixture.end();
});

/** A connection holding temp companies / company_users rows that say the suspended company is live and owned. */
async function shadowed(): Promise<PoolClient> {
  const c = await fixture.connect();
  await c.query(`CREATE TEMP TABLE companies AS SELECT $1::uuid AS id, 'Shadow'::text AS name, true AS is_active,
    'active'::text AS status, NULL::timestamptz AS suspended_at`, [company]);
  await c.query(`CREATE TEMP TABLE company_users AS SELECT $1::uuid AS company_id, $2::text AS user_id, 'owner'::text AS role,
    true AS is_default, NOW() AS created_at`, [company, user]);
  // The shadow is live on this connection: an unqualified read finds it.
  expect((await c.query(`SELECT status FROM companies WHERE id = $1`, [company])).rows).toEqual([{ status: 'active' }]);
  return c;
}
/** Run `fn` with `sql` routed to `c`, as inside a request. */
const on = <T>(c: PoolClient, fn: () => Promise<T>) =>
  als.run({ client: c, userId: user, claims: {} } as unknown as RequestContext, fn);

describe('S-07e: withAuth\'s membership check reads public.*', () => {
  it('a temp companies table that says the suspended company is active does not admit it', async () => {
    const c = await shadowed();
    try {
      expect((await getCompanyMembership(c, user, company)).rows).toEqual([]);
    } finally {
      c.release(true);
    }
  });

  it('nor does it make the suspended company one a session may be pointed at', async () => {
    const c = await shadowed();
    try {
      expect(await on(c, () => isLiveCompanyForUser(user, company))).toBe(false);
      expect(await on(c, () => listLiveCompanyMemberships(user))).toEqual([]);
      expect(await on(c, () => listLiveCompanies([company]))).toEqual([]);
    } finally {
      c.release(true);
    }
  });
});
