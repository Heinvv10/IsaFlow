/**
 * Migration 999r: company_groups and company_group_members under row security, as app_user.
 *
 * Before it: company_groups had no RLS, so any session read every group's name across tenants; and
 * company_group_members' policy (348/498) checked only the company, so a session could insert its own
 * company into ANY group_id, joining someone else's group. Group membership is a trust signal
 * (intercompany auto-accept), so the group is now checked too: a member needs a write role in a current
 * member company of the group (or the creator's bootstrap of a group that never had a member) AND a
 * write role in the company it adds. The siblings are in company-groups-rls-siblings.int.test.ts.
 *
 * Real PostgreSQL, the real service functions; synthetic rows only. Fixture route: isaflow_schema_fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { groupsFixture } from './helpers/companyGroupsRlsFixture';
import {
  addMember, createGroup, getGroup, getGroupMembers, listGroupsForUser, removeMember, updateGroup, updateMember,
} from '@/modules/accounting/services/reports/groupCrudService';
import { creatorMayBootstrapGroup } from '@/modules/accounting/services/core/groupRouteGuards';
import { userCanWriteCompany, userCanWriteGroup } from '@/modules/accounting/services/core/companyAccessService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const F = groupsFixture(pool);
const { co, u, g } = F;
const RLS_DENIED = '42501';
const NEVER_MOVES = '23514'; // the keys-immutable trigger

beforeAll(() => F.setup(), 60000);
afterAll(async () => { await F.cleanup(); await pool.end(); });

/** `fn` through the real service layer: `sql` joins this app_user transaction, as in a withAuth request. */
const asService = <T>(user: string, company: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
  F.asAppUser(user, company, (client: PoolClient) => als.run({ client, userId: user, companyId: company, claims: {} } as never, () => fn(client)));

describe('company_groups: a session reads only the groups it belongs to or created', () => {
  const all = [g.GA, g.GB, g.GE];
  it('a member reads its own group and no other', async () => {
    expect(await F.asAppUser(u.UB, co.B1, (q) => F.visible(q, 'company_groups', all))).toEqual([g.GB]);
  });
  it('a viewer member reads the group; a creator also reads its memberless group', async () => {
    expect(await F.asAppUser(u.UV, co.A3, (q) => F.visible(q, 'company_groups', all))).toEqual([g.GA]);
    expect(await F.asAppUser(u.UA, co.A1, (q) => F.visible(q, 'company_groups', all))).toEqual([g.GA, g.GE].sort());
  });
  it('a company in no group, and a non-creator, read 0 groups and 0 members', async () => {
    await F.asAppUser(u.UC, co.C, async (q) => {
      expect(await F.visible(q, 'company_groups', all)).toEqual([]);
      expect((await q.query('SELECT count(*)::int AS n FROM company_group_members WHERE group_id = ANY($1::uuid[])', [all])).rows[0].n).toBe(0);
    });
  });
  it('the unfiltered list a probe runs holds none of this fixture\'s foreign groups', async () => {
    const names = await F.asAppUser(u.UC, co.C, async (q) => (await q.query("SELECT name FROM company_groups WHERE name LIKE 'CG999r %'")).rows);
    expect(names).toEqual([]);
  });
  it('a group whose member left is no longer visible to the leaver', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1', [g.GA]);
      // UA created GA, so it still sees it; UV (a viewer of A1, not the creator) does not.
      expect(await F.visible(q, 'company_groups', [g.GA])).toEqual([g.GA]);
      await q.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u.UV })]);
      expect(await F.visible(q, 'company_groups', [g.GA])).toEqual([]);
    });
  });
});

describe('company_groups writes', () => {
  it('a session cannot create a group in another user\'s name or name another tenant\'s company as holding', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, 'INSERT INTO company_groups (name, created_by) VALUES ($1, $2::UUID)', ['x', u.UB])).toBe(RLS_DENIED);
      expect(await F.codeOf(q, 'INSERT INTO company_groups (name, created_by, holding_company_id) VALUES ($1, $2::UUID, $3)', ['x', u.UA, co.B1])).toBe(RLS_DENIED);
      expect(await F.codeOf(q, 'INSERT INTO company_groups (name, created_by, holding_company_id) VALUES ($1, $2::UUID, $3)', ['x', u.UA, co.A1])).toBe('ok');
    });
  });
  it('only a writer of a member company updates or soft-deletes a group', async () => {
    await F.asAppUser(u.UB, co.B1, async (q) => {
      expect((await q.query("UPDATE company_groups SET name = 'hijack' WHERE id = $1", [g.GA])).rowCount).toBe(0);
      expect((await q.query('UPDATE company_groups SET is_active = false WHERE id = $1', [g.GB])).rowCount).toBe(1);
    });
    await F.asAppUser(u.UV, co.A3, async (q) => {
      expect((await q.query("UPDATE company_groups SET name = 'viewer' WHERE id = $1", [g.GA])).rowCount).toBe(0);
    });
    expect((await pool.query('SELECT name FROM company_groups WHERE id = $1', [g.GA])).rows[0].name).toBe('CG999r GA');
  });
  it('a writer cannot make a foreign company the holding company', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, 'UPDATE company_groups SET holding_company_id = $2 WHERE id = $1', [g.GA, co.B1])).toBe(RLS_DENIED);
    });
  });
});

describe('company_group_members: nobody joins a group they have no standing in', () => {
  const join = (group: string, company: string) =>
    ['INSERT INTO company_group_members (group_id, company_id) VALUES ($1, $2)', [group, company]] as const;

  it('a company cannot insert itself into a foreign group (the defect)', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => expect(await F.codeOf(q, ...join(g.GB, co.A1))).toBe(RLS_DENIED));
    await F.asAppUser(u.UC, co.C, async (q) => expect(await F.codeOf(q, ...join(g.GB, co.C))).toBe(RLS_DENIED));
  });
  it('nor into the memberless group of another creator', async () => {
    await F.asAppUser(u.UB, co.B1, async (q) => expect(await F.codeOf(q, ...join(g.GE, co.B1))).toBe(RLS_DENIED));
  });
  it('a viewer of the group cannot add even a company it owns', async () => {
    await F.asAppUser(u.UV, co.A3, async (q) => expect(await F.codeOf(q, ...join(g.GA, co.A3))).toBe(RLS_DENIED));
  });
  it('a writer cannot add a company it holds no write role in', async () => {
    await F.asAppUser(u.UA, co.B1, async (q) => expect(await F.codeOf(q, ...join(g.GA, co.B1))).toBe(RLS_DENIED));
    await F.asAppUser(u.UV, co.A1, async (q) => expect(await F.codeOf(q, ...join(g.GA, co.A1))).toBe(RLS_DENIED));
  });
  it('a member row cannot be moved into a foreign group (UPDATE group_id)', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      expect(await F.codeOf(q, 'UPDATE company_group_members SET group_id = $2 WHERE group_id = $1', [g.GA, g.GB])).toBe(NEVER_MOVES);
    });
  });
  it('a writer of the group adds another company it writes; the creator bootstraps an empty group', async () => {
    await F.asAppUser(u.UA, co.A2, async (q) => expect(await F.codeOf(q, ...join(g.GA, co.A2))).toBe('ok'));
    await F.asAppUser(u.UA, co.A1, async (q) => expect(await F.codeOf(q, ...join(g.GE, co.A1))).toBe('ok'));
  });
  it('the bootstrap closes once the group has had a member', async () => {
    await F.asAppUser(u.UA, co.A1, async (q) => {
      await q.query(...join(g.GE, co.A1));
      await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1', [g.GE]);
      await q.query("SELECT set_config('app.current_company_id', $1, true)", [co.A2]);  // A2 is the active company: only the group stands in the way
      expect(await F.codeOf(q, ...join(g.GE, co.A2))).toBe(RLS_DENIED);
    });
  });
  it('a member row is still written with its own company active (unchanged)', async () => {
    await F.asAppUser(u.UA, co.A2, async (q) => {
      await q.query(...join(g.GA, co.A2));
      expect((await q.query('UPDATE company_group_members SET ownership_pct = 50 WHERE group_id = $1 AND company_id = $2', [g.GA, co.A2])).rowCount).toBe(1);
      await q.query("SELECT set_config('app.current_company_id', $1, true)", [co.A1]);
      expect(await F.codeOf(q, 'UPDATE company_group_members SET ownership_pct = 40 WHERE group_id = $1 AND company_id = $2', [g.GA, co.A2])).toBe(RLS_DENIED);
    });
  });
  it('members are read through the member company only (unchanged)', async () => {
    await F.asAppUser(u.UB, co.B1, async (q) => {
      expect((await q.query('SELECT company_id FROM company_group_members WHERE group_id = ANY($1::uuid[])', [[g.GA, g.GB]])).rows.map((r: { company_id: string }) => r.company_id).sort())
        .toEqual([co.B1, co.B2].sort());
    });
  });
});

describe('the legitimate flows still work through the service layer', () => {
  it('create a group without a holding company, bootstrap its first member, then add a second', async () => {
    await asService(u.UA, co.A1, async () => {
      const group = await createGroup({ name: 'CG999r new' }, u.UA);
      expect(await listGroupsForUser(u.UA)).toContainEqual(expect.objectContaining({ id: group.id }));
      expect(await userCanWriteGroup(u.UA, group.id)).toBe(false);
      expect(await creatorMayBootstrapGroup(u.UA, group.id)).toBe(true);
      expect(await userCanWriteCompany(u.UA, co.A1)).toBe(true);
      const first = await addMember(group.id, co.A1, { ownershipPct: 100 });
      expect(first.companyId).toBe(co.A1);
      expect(await userCanWriteGroup(u.UA, group.id)).toBe(true);
      expect((await getGroup(group.id))?.memberCount).toBe(1);
    });
    await asService(u.UA, co.A2, async () => {
      const second = await addMember(g.GA, co.A2, { ownershipPct: 60, consolidationMethod: 'proportionate' });
      expect(second.consolidationMethod).toBe('proportionate');
      expect((await getGroupMembers(g.GA)).map((m) => m.companyId).sort()).toEqual([co.A1, co.A2].sort());
    });
  });
  it('create a group with the active company as holding company: the group and its holding member', async () => {
    await asService(u.UB, co.B2, async () => {
      const group = await createGroup({ name: 'CG999r holding', holdingCompanyId: co.B2 }, u.UB);
      expect((await getGroupMembers(group.id)).map((m) => [m.companyId, m.isHolding])).toEqual([[co.B2, true]]);
      expect((await updateGroup(group.id, { name: 'CG999r renamed' })).name).toBe('CG999r renamed');
    });
  });
  // A member row is written with its own company active (the policy's WITH CHECK has always said so).
  it('update a member, and remove (retire) a member, including a company\'s own last membership', async () => {
    const rowOf = async (company: string) => (await getGroupMembers(g.GB)).find((m) => m.companyId === company)!;
    const b2 = await asService(u.UB, co.B2, async () => rowOf(co.B2));
    await asService(u.UB, co.B2, async () => {
      expect((await updateMember(b2.id, { ownershipPct: 40 }, g.GB)).ownershipPct).toBe(40);
      await removeMember(b2.id, g.GB);
    });
    const b1 = await asService(u.UB, co.B1, async () => rowOf(co.B1));
    await asService(u.UB, co.B1, async () => { await removeMember(b1.id, g.GB); expect((await getGroupMembers(g.GB)).map((m) => m.companyId)).toEqual([co.B2]); });
  });
  it('the service refuses a foreign group the way the route does: no row appears', async () => {
    await asService(u.UA, co.A1, async (client) => {
      await client.query('SAVEPOINT refused');
      await expect(addMember(g.GB, co.A1)).rejects.toMatchObject({ code: RLS_DENIED });
      await client.query('ROLLBACK TO SAVEPOINT refused');
      expect(await getGroup(g.GB)).toBeNull();
    });
  });
});
