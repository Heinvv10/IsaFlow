/**
 * R-035 N1b (C, migration 883): every legitimate membership and invitation
 * flow still works with the guards on — through the real routes where there
 * is one, and as the database role the path really writes as where there is
 * not (the admin portal as platform_admin; invite-accept and provisioning as
 * migration_admin; definer functions as app_user). Who may do what is the
 * app's, unchanged, except the one rule Hein added (2026-10-09): only an owner
 * may invite someone as `owner`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRole, outcome } from './r035-n1.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import {
  acceptAsInvitee, cleanupMembers, company, emailOf, people, roleOf, routes, tokenHash, type People,
} from './r035-n1b-members.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
let p: People;

beforeAll(async () => { p = await people(pool, users); });
afterAll(() => cleanupMembers(pool, companies, users));

const invitationsOf = async (c: string) => (await pool.query(
  'SELECT email, role, invited_by FROM company_invitations WHERE company_id = $1 ORDER BY created_at', [c])).rows;

describe('member roles through PUT/DELETE /api/accounting/company-users', () => {
  it('an owner grants owner; an admin may not (403, H5)', async () => {
    const c = await company(pool, p, companies);
    expect((await (await routes(p.a, c)).members('PUT', { userId: p.m, role: 'owner' })).state.statusCode).toBe(403);
    expect((await (await routes(p.o, c)).members('PUT', { userId: p.m, role: 'owner' })).state.statusCode).toBe(200);
    expect(await roleOf(pool, c, p.m)).toBe('owner');
  });

  it('an admin manages roles below owner and changes their own role; an owner demotes a non-last owner', async () => {
    const c = await company(pool, p, companies);
    const r = await routes(p.a, c);
    expect((await r.members('PUT', { userId: p.m, role: 'viewer' })).state.statusCode).toBe(200);
    expect((await r.members('PUT', { userId: p.a, role: 'manager' })).state.statusCode).toBe(200);
    expect((await (await routes(p.o, c)).members('PUT', { userId: p.o2, role: 'admin' })).state.statusCode).toBe(200);
    expect([await roleOf(pool, c, p.m), await roleOf(pool, c, p.o2), await roleOf(pool, c, p.a)]).toEqual(['viewer', 'admin', 'manager']);
  });

  // Audit S-04 (2026-10-21): only an owner may change or remove an owner.
  it('an admin may not demote or remove an owner, even a non-last one (403, nothing written)', async () => {
    const c = await company(pool, p, companies);
    const r = await routes(p.a, c);
    const demote = await r.members('PUT', { userId: p.o2, role: 'admin' });
    expect(demote.state.statusCode).toBe(403);
    expect(messageOf(demote)).toBe('Only an owner can change or remove another owner.');
    const remove = await r.members('DELETE', { userId: p.o2 });
    expect(remove.state.statusCode).toBe(403);
    expect(messageOf(remove)).toBe('Only an owner can change or remove another owner.');
    expect(await roleOf(pool, c, p.o2)).toBe('owner');
  });

  it('removes a member; refuses removing yourself and the last owner', async () => {
    const c = await company(pool, p, companies, [[p.o, 'owner'], [p.a, 'admin'], [p.m, 'manager']]);
    const r = await routes(p.a, c);
    expect((await r.members('DELETE', { userId: p.m })).state.statusCode).toBe(200);
    expect((await r.members('DELETE', { userId: p.a })).state.statusCode).toBe(400);
    // An admin never reaches the last-owner rule on an owner (S-04: 403 first);
    // the last owner demoting themselves gets the service's refusal as a 400.
    expect((await r.members('DELETE', { userId: p.o })).state.statusCode).toBe(403);
    expect((await (await routes(p.o, c)).members('PUT', { userId: p.o, role: 'admin' })).state.statusCode).toBe(400);
    expect([await roleOf(pool, c, p.m), await roleOf(pool, c, p.a), await roleOf(pool, c, p.o)]).toEqual([null, 'admin', 'owner']);
  });
});

describe('invitations', () => {
  it('an owner invites someone as owner; an admin may not (403, nothing written); an admin invites a manager', async () => {
    const c = await company(pool, p, companies);
    const admin = await routes(p.a, c);
    const refused = await admin.invitations('POST', { email: emailOf(p.x), role: 'owner' });
    expect(refused.state.statusCode).toBe(403);
    expect(messageOf(refused)).toBe('Only an owner can grant the owner role.');
    expect(await invitationsOf(c)).toEqual([]);
    expect((await admin.invitations('POST', { email: emailOf(p.x), role: 'manager' })).state.statusCode).toBe(200);
    expect((await (await routes(p.o, c)).invitations('POST', { email: emailOf(p.x), role: 'owner' })).state.statusCode).toBe(200);
    expect(await invitationsOf(c)).toEqual([{ email: emailOf(p.x), role: 'owner', invited_by: p.o }]);
  });

  it('an admin cancels an invitation', async () => {
    const c = await company(pool, p, companies);
    const admin = await routes(p.a, c);
    await admin.invitations('POST', { email: emailOf(p.x), role: 'viewer' });
    const [inv] = (await pool.query('SELECT id FROM company_invitations WHERE company_id = $1', [c])).rows;
    expect((await admin.invitations('DELETE', { invitationId: inv.id })).state.statusCode).toBe(200);
    expect(await invitationsOf(c)).toEqual([]);
  });

  it.each([['an owner', 'o', 'owner'], ['an admin', 'a', 'manager']] as const)(
    "%s's %s invitation, accepted at /invite/<token>, makes the invitee that role", async (_label, by, role) => {
      const c = await company(pool, p, companies);
      const raw = `n1bf${'0'.repeat(28)}${crypto.randomUUID().replace(/-/g, '')}`;
      // Written as the route writes it — as app_user, by the inviter — so the guard judges it.
      expect(await outcome(asRole(pool, 'app_user', c, { sub: p[by] }, (cl) => cl.query(
        `INSERT INTO company_invitations(company_id,email,role,invited_by,token,expires_at)
         VALUES($1,$2,$3,$4,$5, now() + interval '7 days')`, [c, emailOf(p.x), role, p[by], tokenHash(raw)]), true))).toBe('ok');
      expect((await acceptAsInvitee(p.x, raw)).state.statusCode).toBe(200);
      expect(await roleOf(pool, c, p.x)).toBe(role);
    });
});

describe('paths without a user JWT, as the role they write as', () => {
  it('the admin portal (platform_admin): add, overwrite an owner below owner, remove, delete a user', async () => {
    const c = await company(pool, p, companies);
    const portal = (sql: string, params: unknown[]) => outcome(asRole(pool, 'platform_admin', c, { sub: p.o }, (cl) => cl.query(sql, params), true));
    const add = `INSERT INTO company_users (user_id, company_id, role, created_at) VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (user_id, company_id) DO UPDATE SET role = EXCLUDED.role`;
    expect(await portal(add, [p.x, c, 'accountant'])).toBe('ok');
    expect(await portal(add, [p.o2, c, 'admin'])).toBe('ok');
    expect(await portal('DELETE FROM company_users WHERE user_id = $1 AND company_id = $2', [p.m, c])).toBe('ok');
    expect(await portal('DELETE FROM company_users WHERE user_id = $1 AND company_id = $2::UUID', [p.x, c])).toBe('ok');
    expect([await roleOf(pool, c, p.x), await roleOf(pool, c, p.o2), await roleOf(pool, c, p.m)]).toEqual([null, 'admin', null]);
  });

  it('create_company_with_owner and set_default_company, as app_user (SECURITY DEFINER)', async () => {
    const c = await company(pool, p, companies);
    const created = await asRole(pool, 'app_user', c, { sub: p.x }, async (cl) => (await cl.query(
      "SELECT id FROM public.create_company_with_owner(jsonb_build_object('name', 'N1b C created'))")).rows[0].id as string, true);
    companies.push(created);
    expect(await roleOf(pool, created, p.x)).toBe('owner');
    expect(await outcome(asRole(pool, 'app_user', created, { sub: p.x }, (cl) => cl.query(
      'SELECT auth.set_default_company($1::UUID, $2::UUID)', [p.x, created]), true))).toBe('ok');
  });

  it('invite-accept and tenant provisioning (migration_admin), where that role reaches the table', async (ctx) => {
    const { rows: [can] } = await pool.query(
      "SELECT rolbypassrls OR rolsuper AS ok FROM pg_roles WHERE rolname = 'migration_admin'");
    // Reported as skipped, never a silent pass: the classic fixture's
    // migration_admin cannot see the RLS-forced table at all.
    ctx.skip(!can.ok, 'migration_admin neither bypasses RLS nor is superuser here (classic fixture)');
    const c = await company(pool, p, companies);
    const c2 = await pool.connect();
    try {
      await c2.query('BEGIN');
      await c2.query('SET LOCAL ROLE migration_admin');
      await c2.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1::uuid,$2,'owner')
                      ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [c, p.x]);
      await c2.query('COMMIT');
    } finally { c2.release(); }
    expect(await roleOf(pool, c, p.x)).toBe('owner');
  });
});

describe('reads are untouched', () => {
  it('GET company-users lists the members', async () => {
    const c = await company(pool, p, companies);
    const res = await (await routes(p.o, c)).members('GET', undefined);
    expect(res.state.statusCode).toBe(200);
    expect((dataOf<unknown[]>(res)).length).toBe(4);
  });
});
