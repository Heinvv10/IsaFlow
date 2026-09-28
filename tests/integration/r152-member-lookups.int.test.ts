/**
 * R-152 review LOW 1/2: two more `users` JOINs under app_user with the same
 * users_self_read defect, both uncalled today — practiceUsersService
 * .getCompanyUser and permissionService.getCompanyUsersWithPermissions. A
 * future request-path caller would get null / only the viewer. Both now read
 * through company_member_directory (migration 716), which mirrors cu_select:
 * owner/admin see every member, lower roles only their own row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { getCompanyUser } from '@/modules/accounting/services/practice/practiceUsersService';
import { getCompanyUsersWithPermissions } from '@/lib/auth/permissionService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanup, newCompany } from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];

async function namedUser(email: string, firstName: string, lastName: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO users(id,email,first_name,last_name,role,is_active) VALUES($1,$2,$3,$4,$5,true)',
    [id, email, firstName, lastName, 'admin']);
  users.push(id);
  return id;
}

/** Runs a service the way withAuth would: app_user, JWT sub, active company, request client in ALS. */
async function asUser<T>(userId: string, companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    return await als.run({ client, userId, companyId, claims: {} } as never, fn);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

let owner = '';
let other = '';
let viewer = '';

beforeAll(async () => {
  owner = await namedUser('r152-lookup-owner@test.local', 'Ayanda', 'Zulu');
  other = await namedUser('r152-lookup-other@test.local', 'Johan', 'Smit');
  viewer = await namedUser('r152-lookup-viewer@test.local', 'Naledi', 'Mahlangu');
});
afterAll(() => cleanup(pool, companies, users));

describe('practiceUsersService.getCompanyUser resolves another member for an owner (R-152 LOW 1)', () => {
  it('an owner gets the other member\'s row', async () => {
    const company = await newCompany(pool, [[owner, 'owner'], [other, 'owner']], companies);
    const row = await asUser(owner, company, () => getCompanyUser(company, other));
    expect(row).toMatchObject({ id: other, email: 'r152-lookup-other@test.local', companyRole: 'owner' });
  });

  it('a viewer asking for another member gets nothing', async () => {
    const company = await newCompany(pool, [[owner, 'owner'], [viewer, 'viewer']], companies);
    expect(await asUser(viewer, company, () => getCompanyUser(company, owner))).toBeNull();
  });

  it('a viewer still gets their own row', async () => {
    const company = await newCompany(pool, [[owner, 'owner'], [viewer, 'viewer']], companies);
    const row = await asUser(viewer, company, () => getCompanyUser(company, viewer));
    expect(row).toMatchObject({ id: viewer, companyRole: 'viewer' });
  });
});

describe('permissionService.getCompanyUsersWithPermissions lists every member for an owner (R-152 LOW 2)', () => {
  it('an owner gets both members, with the other member\'s email', async () => {
    const company = await newCompany(pool, [[owner, 'owner'], [other, 'owner']], companies);
    const rows = await asUser(owner, company, () => getCompanyUsersWithPermissions(company));
    expect(rows.map((r) => r.userId).sort()).toEqual([owner, other].sort());
    expect(rows.find((r) => r.userId === other)).toMatchObject({ email: 'r152-lookup-other@test.local', role: 'owner' });
  });

  it('a viewer gets only their own row, never another member\'s', async () => {
    const company = await newCompany(pool, [[owner, 'owner'], [viewer, 'viewer']], companies);
    const rows = await asUser(viewer, company, () => getCompanyUsersWithPermissions(company));
    expect(rows.map((r) => r.userId)).toEqual([viewer]);
  });
});
