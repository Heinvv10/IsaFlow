/**
 * R-035 N1b (C, migration 882): company_users and company_invitations refuse,
 * by raw SQL, every role change the app refuses — as app_user (an admin of
 * the company, under real claims) and as platform_admin. Each forgery went
 * through before 882 (RLS `cu_admin_write` / `invites_tenant` allowed it); each
 * is refused after, with the row unchanged. The headline case end to end: an
 * admin forges an `owner` invitation for their other account and accepts it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRole, outcome } from './r035-n1.helpers';
import {
  acceptAsInvitee, cleanupMembers, company, emailOf, people, roleOf, tokenHash, type People,
} from './r035-n1b-members.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
let p: People;

beforeAll(async () => { p = await people(pool, users); });
afterAll(() => cleanupMembers(pool, companies, users));

/** Raw SQL in company `c` as app_user under `sub`'s claims, committed if it gets through. */
const asApp = (c: string, sub: string, fn: (cl: PoolClient) => Promise<unknown>) => asRole(pool, 'app_user', c, { sub }, fn, true);
const asPortal = (c: string, fn: (cl: PoolClient) => Promise<unknown>) => asRole(pool, 'platform_admin', c, { sub: p.o }, fn, true);
const invitation = (c: string, by: string, role: string, email: string, raw = crypto.randomUUID()) => [
  `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at)
   VALUES($1,$2,$3,$4,$5, now() + interval '7 days')`, [c, email, role, by, tokenHash(raw)]] as const;

describe('as app_user, an admin cannot by raw SQL', () => {
  it('promote themselves to owner (RC003)', async () => {
    const c = await company(pool, p, companies);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      "UPDATE company_users SET role = 'owner' WHERE company_id = $1 AND user_id = $2", [c, p.a])))).toBe('RC003');
    expect(await roleOf(pool, c, p.a)).toBe('admin');
  });

  it("move an owner's membership to another account (RC004)", async () => {
    const c = await company(pool, p, companies);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      'UPDATE company_users SET user_id = $3 WHERE company_id = $1 AND user_id = $2', [c, p.o, p.x])))).toBe('RC004');
    expect([await roleOf(pool, c, p.o), await roleOf(pool, c, p.x)]).toEqual(['owner', null]);
  });

  it('add another account as owner (RC003), or with a role off the list (RC002)', async () => {
    const c = await company(pool, p, companies);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      "INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [c, p.x])))).toBe('RC003');
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      "INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'super_admin')", [c, p.x])))).toBe('RC002');
    expect(await roleOf(pool, c, p.x)).toBeNull();
  });

  it('remove themselves (RC006)', async () => {
    const c = await company(pool, p, companies);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      'DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [c, p.a])))).toBe('RC006');
    expect(await roleOf(pool, c, p.a)).toBe('admin');
  });

  it('demote or remove the last owner (RC005)', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.a, 'admin']]);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      "UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [c, p.o])))).toBe('RC005');
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      'DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [c, p.o])))).toBe('RC005');
    expect(await roleOf(pool, c, p.o)).toBe('owner');
  });

  it("change anything of a membership but its role (RC004)", async () => {
    const c = await company(pool, p, companies);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      'UPDATE company_users SET is_default = true WHERE company_id = $1 AND user_id = $2', [c, p.m])))).toBe('RC004');
  });

  it('create an owner invitation (RC003), or upgrade one to owner (RC003)', async () => {
    const c = await company(pool, p, companies);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(...invitation(c, p.a, 'owner', emailOf(p.x)))))).toBe('RC003');
    await pool.query(...invitation(c, p.o, 'viewer', emailOf(p.x)));
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(
      "UPDATE company_invitations SET role = 'owner', invited_by = $2 WHERE company_id = $1", [c, p.a])))).toBe('RC003');
    expect((await pool.query('SELECT role FROM company_invitations WHERE company_id = $1', [c])).rows).toEqual([{ role: 'viewer' }]);
  });

  it('record someone else as the inviter (RC009)', async () => {
    const c = await company(pool, p, companies);
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(...invitation(c, p.o, 'admin', emailOf(p.x)))))).toBe('RC009');
  });
});

describe('as app_user, a manager (a member, not an admin) cannot', () => {
  it('write or delete an invitation (RC001) — RLS let any member before 882', async () => {
    const c = await company(pool, p, companies);
    expect(await outcome(asApp(c, p.m, (cl) => cl.query(...invitation(c, p.m, 'viewer', emailOf(p.x)))))).toBe('RC001');
    await pool.query(...invitation(c, p.o, 'viewer', emailOf(p.x)));
    expect(await outcome(asApp(c, p.m, (cl) => cl.query('DELETE FROM company_invitations WHERE company_id = $1', [c])))).toBe('RC001');
    expect((await pool.query('SELECT count(*)::INT AS n FROM company_invitations WHERE company_id = $1', [c])).rows[0].n).toBe(1);
  });
});

describe('end to end: a forged owner invitation, then accepted', () => {
  it('is refused at the forgery, so the accept finds nothing and nobody becomes owner', async () => {
    const c = await company(pool, p, companies);
    const raw = `n1bc${'0'.repeat(28)}${p.x.replace(/-/g, '')}`;
    expect(await outcome(asApp(c, p.a, (cl) => cl.query(...invitation(c, p.a, 'owner', emailOf(p.x), raw))))).toBe('RC003');
    expect((await acceptAsInvitee(p.x, raw)).state.statusCode).toBe(404);
    expect(await roleOf(pool, c, p.x)).toBeNull();
  });
});

describe('as platform_admin, raw SQL cannot', () => {
  it.each([
    ['grant owner by insert', "INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')"],
    ['grant owner by update', "UPDATE company_users SET role = 'owner' WHERE company_id = $1 AND role = 'admin' AND $2::TEXT IS NOT NULL"],
    ['grant a role the portal never offers (manager)', "INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'manager')"],
  ])('%s (RC007)', async (_label, statement) => {
    const c = await company(pool, p, companies);
    expect(await outcome(asPortal(c, (cl) => cl.query(statement, [c, p.x])))).toBe('RC007');
    expect([await roleOf(pool, c, p.x), await roleOf(pool, c, p.a)]).toEqual([null, 'admin']);
  });

  it('write an invitation (RC008)', async () => {
    const c = await company(pool, p, companies);
    expect(await outcome(asPortal(c, (cl) => cl.query(...invitation(c, p.o, 'owner', emailOf(p.x)))))).toBe('RC008');
  });
});
