/**
 * R-152: Manage Users (/accounting/user-access) and the practice users list
 * showed each viewer only themselves. Both listCompanyUsers
 * (userAccessService, practiceUsersService) INNER JOINed `users` under
 * withAuth (app_user); `users_self_read` (FORCE RLS, `id = auth.uid()`)
 * hides every other member's users row, so the join dropped those members.
 * company_users' own policy (cu_select: own row, or every row of a company
 * the caller administers) was never the cause.
 *
 * Fixed by company_member_directory() (migration 716), a SECURITY DEFINER
 * list that mirrors cu_select exactly: an owner/admin gets every member, a
 * lower role only their own row — never more than company_users RLS allows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import companyUsersHandler from '../../pages/api/accounting/company-users';
import practiceUsersHandler from '../../pages/api/accounting/practice/users';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, newCompany, sign } from './r035-approval.helpers';
import {
  listCompanyUsers as listPracticeUsers,
  listCompanyUsersForSystem,
} from '@/modules/accounting/services/practice/practiceUsersService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
const tokens: Record<string, string> = {};

async function namedUser(email: string, firstName: string, lastName: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO users(id,email,first_name,last_name,role,is_active) VALUES($1,$2,$3,$4,$5,true)',
    [id, email, firstName, lastName, 'admin']);
  tokens[id] = await sign(id);
  users.push(id);
  return id;
}

let ownerA = '';
let ownerB = '';
let viewer = '';
let outsider = '';

beforeAll(async () => {
  ownerA = await namedUser('r152-owner-a@test.local', 'Thandi', 'Mokoena');
  ownerB = await namedUser('r152-owner-b@test.local', 'Pieter', 'Naidoo');
  viewer = await namedUser('r152-viewer@test.local', 'Lerato', 'Venter');
  outsider = await namedUser('r152-outsider@test.local', 'Other', 'Company');
});
afterAll(() => cleanup(pool, companies, users));

type Member = { userId: string; email: string; role: string };
type PracticeUser = { id: string; email: string; companyRole: string };
const dataOf = <T>(result: { state: { body: unknown } }) => (result.state.body as { data: T }).data;

async function listAs(userId: string, company: string) {
  const res = await callRoute(companyUsersHandler, tokens[userId]!, company, 'GET', undefined, '/api/accounting/company-users');
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return dataOf<Member[]>(res);
}

async function practiceListAs(userId: string, company: string) {
  const res = await callRoute(practiceUsersHandler, tokens[userId]!, company, 'GET', undefined, '/api/accounting/practice/users');
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return dataOf<PracticeUser[]>(res);
}

describe('GET /api/accounting/company-users lists every member to an owner (R-152)', () => {
  it('an owner in a 2-owner company sees both members, with the other owner\'s email', async () => {
    const company = await newCompany(pool, [[ownerA, 'owner'], [ownerB, 'owner']], companies);
    const rows = await listAs(ownerA, company);
    expect(rows.map((r) => r.userId).sort()).toEqual([ownerA, ownerB].sort());
    expect(rows.find((r) => r.userId === ownerB)).toMatchObject({ email: 'r152-owner-b@test.local', role: 'owner' });
  });

  it('an admin (not owner) also sees every member', async () => {
    const company = await newCompany(pool, [[ownerA, 'owner'], [ownerB, 'admin'], [viewer, 'viewer']], companies);
    const rows = await listAs(ownerB, company);
    expect(rows.map((r) => r.userId).sort()).toEqual([ownerA, ownerB, viewer].sort());
  });

  it('a viewer (below admin) still sees only their OWN row, exactly as company_users RLS allows', async () => {
    const company = await newCompany(pool, [[ownerA, 'owner'], [viewer, 'viewer']], companies);
    const rows = await listAs(viewer, company);
    expect(rows.map((r) => r.userId)).toEqual([viewer]);
  });

  it('a member of another company never appears in the list', async () => {
    const company = await newCompany(pool, [[ownerA, 'owner'], [ownerB, 'owner']], companies);
    await newCompany(pool, [[outsider, 'owner'], [ownerA, 'owner']], companies);
    const rows = await listAs(ownerA, company);
    expect(rows.map((r) => r.userId)).not.toContain(outsider);
    expect(rows).toHaveLength(2);
  });
});

describe('GET /api/accounting/practice/users lists every member to an owner (R-152)', () => {
  it('an owner in a 2-owner company sees both members', async () => {
    const company = await newCompany(pool, [[ownerA, 'owner'], [ownerB, 'owner']], companies);
    const rows = await practiceListAs(ownerA, company);
    expect(rows.map((r) => r.id).sort()).toEqual([ownerA, ownerB].sort());
    expect(rows.find((r) => r.id === ownerB)).toMatchObject({ email: 'r152-owner-b@test.local', companyRole: 'owner' });
  });

  it('a viewer still sees only their OWN row', async () => {
    const company = await newCompany(pool, [[ownerA, 'owner'], [viewer, 'viewer']], companies);
    const rows = await practiceListAs(viewer, company);
    expect(rows.map((r) => r.id)).toEqual([viewer]);
  });

  it('an inactive member is still left out, as before', async () => {
    const inactive = await namedUser('r152-inactive@test.local', 'Gone', 'Away');
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [inactive]);
    const company = await newCompany(pool, [[ownerA, 'owner'], [inactive, 'owner']], companies);
    const rows = await practiceListAs(ownerA, company);
    expect(rows.map((r) => r.id)).toEqual([ownerA]);
  });
});

/** Sets the session GUCs a real withAuth request would (sub + active company), then SET ROLE app_user. */
async function asSession(client: PoolClient, userId: string, sessionCompanyId: string): Promise<void> {
  await client.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId })]);
  await client.query("SELECT set_config('app.current_company_id', $1, false)", [sessionCompanyId]);
  await client.query('SET ROLE app_user');
}

async function directoryAs(userId: string, sessionCompany: string, argCompany: string) {
  const client = await pool.connect();
  try {
    await asSession(client, userId, sessionCompany);
    return (await client.query('SELECT * FROM public.company_member_directory($1)', [argCompany])).rows;
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
}

describe('company_member_directory refuses the two 42501 guards (R-152)', () => {
  it('refuses (42501, "own company") when a member of A names company B as the argument', async () => {
    const companyA = await newCompany(pool, [[ownerA, 'owner']], companies);
    const companyB = await newCompany(pool, [[ownerB, 'owner']], companies);
    await expect(directoryAs(ownerA, companyA, companyB)).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining("answers only for the caller's own company"),
    });
  });

  it('refuses (42501, "not a member") when the session company matches the argument but the caller has no row there', async () => {
    const companyB = await newCompany(pool, [[ownerB, 'owner']], companies);
    await expect(directoryAs(ownerA, companyB, companyB)).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining('caller is not a member of this company'),
    });
  });

  it('answers when the session company matches and the caller is a member (paired positive)', async () => {
    const company = await newCompany(pool, [[ownerA, 'owner'], [ownerB, 'owner']], companies);
    const rows = await directoryAs(ownerA, company, company);
    expect(rows.map((r: { user_id: string }) => r.user_id).sort()).toEqual([ownerA, ownerB].sort());
  });
});

describe('a member of company A cannot list company B through the route (R-152)', () => {
  it('is refused when the active-company cookie names a company the caller is not in', async () => {
    const companyB = await newCompany(pool, [[ownerB, 'owner'], [outsider, 'owner']], companies);
    await newCompany(pool, [[ownerA, 'owner']], companies);
    const res = await callRoute(companyUsersHandler, tokens[ownerA]!, companyB, 'GET', undefined, '/api/accounting/company-users');
    expect(res.state.statusCode).toBe(403);
    expect(JSON.stringify(res.state.body)).not.toContain('r152-owner-b@test.local');
  });
});

describe('the practice crons (no withAuth, no principal) keep listing every member (R-152)', () => {
  it('listCompanyUsersForSystem lists both members outside any request session', async () => {
    const company = await newCompany(pool, [[ownerA, 'owner'], [ownerB, 'owner']], companies);
    const rows = await listCompanyUsersForSystem(company);
    expect(rows.map((r) => r.id).sort()).toEqual([ownerA, ownerB].sort());
  });

  it('the request-scoped listCompanyUsers refuses a principal-less caller rather than listing nobody', async () => {
    const company = await newCompany(pool, [[ownerA, 'owner']], companies);
    await expect(listPracticeUsers(company)).rejects.toMatchObject({ code: '42501' });
  });
});
