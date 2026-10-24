// tests/integration/s07d-member-writes.int.test.ts
//
// S-07d (migration 937): role changes and removals run on the migration_admin
// pool (memberWrites.ts), which company_users_role_guard judges only for the
// last owner (RC011). The rules the guard enforced for app_user, and the races
// its suites proved (r035-n1b-members-takeover, s0408-owner-rules-908b-races,
// s04-owner-protection), are proved here for the TypeScript checks, on the
// production migration_admin login: every concurrent writer is judged after
// the one it waited for has committed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { updateCompanyUserRole, removeCompanyUser } from '@/modules/accounting/services/core/memberWrites';
import { OwnerProtectedError, ownerLockKey } from '@/modules/accounting/services/core/ownerLock';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const companies: string[] = [];
const users = Array.from({ length: 4 }, () => crypto.randomUUID());
const [o, o2, a, m] = users as [string, string, string, string];

beforeAll(async () => {
  await setup(ids);
  for (const u of users) {
    await fixture.query(`INSERT INTO users (id, email, first_name, last_name, is_active, status)
      VALUES ($1, $2, 'S07d', 'S07d', true, 'active')`, [u, `${u}@test.local`]);
  }
}, 60000);
afterAll(async () => {
  await fixture.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [companies]);
  await fixture.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
  await fixture.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  await teardown(ids, [migrationAdminPool()]);
});

/** A fresh company with these members (default: two owners, an admin, a manager). */
async function company(members: Array<[string, string]> = [[o, 'owner'], [o2, 'owner'], [a, 'admin'], [m, 'manager']]): Promise<string> {
  const c = crypto.randomUUID();
  companies.push(c);
  await fixture.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, 'S07d members', true)`, [c]);
  for (const [u, r] of members) await fixture.query('INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)', [c, u, r]);
  return c;
}
const roleOf = async (c: string, u: string) => (await fixture.query(
  'SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [c, u])).rows[0]?.role ?? null;
const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.constructor.name === 'Error' ? e.message : e.constructor.name);

/** Waits until at least `n` migration_admin backends wait on a lock. */
async function adminBlocked(n = 1): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await fixture.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'migration_admin' AND wait_event_type = 'Lock'`);
    if (r.rows[0].n >= n) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`fewer than ${n} migration_admin backends ever waited on a lock`);
}

/** A session that runs `steps` and holds them uncommitted until `commit()`. */
async function holding(steps: Array<[string, unknown[]]>, role?: string): Promise<{ commit: () => Promise<void> }> {
  const cl: PoolClient = await fixture.connect();
  await cl.query('BEGIN');
  if (role) await cl.query(`SET LOCAL ROLE ${role}`);
  for (const [text, params] of steps) await cl.query(text, params);
  return { commit: async () => { try { await cl.query('COMMIT'); } finally { cl.release(); } } };
}
const OWNER_LOCK = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

describe('S-07d: member writes on migration_admin, judged after what they waited for', () => {
  it.each([1, 2, 3, 4, 5])('two owners demoting each other at once: one commits, the other is refused (RC010), round %i', async () => {
    const c = await company();
    const gate = await holding([[OWNER_LOCK, [ownerLockKey(c)]]]);
    const one = outcome(updateCompanyUserRole(c, o2, 'admin', o));
    const two = outcome(updateCompanyUserRole(c, o, 'admin', o2));
    await adminBlocked(1); // the first holds both rows and waits on the owner lock; the second waits on its rows
    await adminBlocked(2);
    await gate.commit();
    expect([await one, await two].sort()).toEqual(['OwnerProtectedError', 'ok']);
    const owners = [await roleOf(c, o), await roleOf(c, o2)].filter((r) => r === 'owner');
    expect(owners).toHaveLength(1);
  });

  it.each([1, 2, 3, 4, 5])('two owners removing each other at once: one removal commits, the other is refused, round %i', async () => {
    const c = await company();
    const gate = await holding([[OWNER_LOCK, [ownerLockKey(c)]]]);
    const one = outcome(removeCompanyUser(c, o2, o));
    const two = outcome(removeCompanyUser(c, o, o2));
    await adminBlocked(2);
    await gate.commit();
    expect([await one, await two].sort()).toEqual(['OwnerProtectedError', 'ok']);
    expect([await roleOf(c, o), await roleOf(c, o2)].filter((r) => r === 'owner')).toHaveLength(1);
  });

  it.each([1, 2, 3, 4, 5])('two admins changing each other\'s roles at once queue instead of deadlocking, round %i', async () => {
    const c = await company([[o, 'owner'], [a, 'admin'], [m, 'admin']]);
    const results = await Promise.all([
      outcome(updateCompanyUserRole(c, m, 'viewer', a)),
      outcome(updateCompanyUserRole(c, a, 'viewer', m)),
    ]);
    // One commits; the other's actor was demoted by it, judged after it: never a 40P01.
    expect(results.sort()).toEqual(['MemberRoleForbiddenError', 'ok']);
  });

  it('an invalid role is refused (RC002) and a legacy owner-ish row rewritten to itself still needs an owner', async () => {
    const c = await company([[o, 'owner'], [o2, 'Owner '], [a, 'admin']]);
    expect(await outcome(updateCompanyUserRole(c, a, 'super_admin', o))).toBe('Invalid role. Must be one of: owner, admin, manager, viewer');
    expect(await outcome(updateCompanyUserRole(c, o2, 'owner', a))).toBe('OwnerProtectedError');
    expect(await outcome(updateCompanyUserRole(c, o2, 'owner', o))).toBe('ok');
  });

  it('an admin whose other, case-variant row is owner-ish is not an owner (the guard reads exactly \'owner\')', async () => {
    const c = await company([[o, 'owner'], [a, 'admin'], [a.toUpperCase(), 'Owner '], [m, 'manager']]);
    expect(await outcome(updateCompanyUserRole(c, m, 'owner', a))).toBe('OwnerProtectedError');
    expect(await roleOf(c, m)).toBe('manager');
  });

  it('an owner being demoted at that moment cannot grant owner (RC003)', async () => {
    const c = await company();
    const demotion = await holding([[OWNER_LOCK, [ownerLockKey(c)]],
      [`UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2`, [c, o]]]);
    const grant = outcome(updateCompanyUserRole(c, m, 'owner', o));
    await adminBlocked();
    await demotion.commit();
    expect(await grant).toBe('OwnerProtectedError');
    expect(await roleOf(c, m)).toBe('manager');
  });

  it('an admin being demoted at that moment cannot change a member\'s role (RC001)', async () => {
    const c = await company();
    const demotion = await holding([[`UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2`, [c, a]]]);
    const change = outcome(updateCompanyUserRole(c, m, 'viewer', a));
    await adminBlocked();
    await demotion.commit();
    expect(await change).toBe('MemberRoleForbiddenError');
    expect(await roleOf(c, m)).toBe('manager');
  });

  it('an admin demoting a member an owner is promoting at that moment never demotes an owner (the target is read FOR UPDATE)', async () => {
    const c = await company();
    const promotion = await holding([[OWNER_LOCK, [ownerLockKey(c)]],
      [`UPDATE company_users SET role = 'owner' WHERE company_id = $1 AND user_id = $2`, [c, m]]]);
    const demotion = outcome(updateCompanyUserRole(c, m, 'viewer', a));
    await adminBlocked();
    await promotion.commit();
    expect(await demotion).toBe('OwnerProtectedError');
    expect(await roleOf(c, m)).toBe('owner');
  });

  it.each([
    ['removal', 'DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', null],
    ['demotion', "UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2", 'admin'],
  ])('a portal %s of one owner and that owner\'s demotion of the other: the second waits, then is refused', async (_, portalWrite, after) => {
    const c = await company();
    const portal = await holding([[portalWrite, [c, o2]]], 'platform_admin');
    const demote = outcome(updateCompanyUserRole(c, o, 'admin', o2));
    await adminBlocked();
    await portal.commit();
    expect(await demote).toBe('OwnerProtectedError');
    expect([await roleOf(c, o), await roleOf(c, o2)]).toEqual(['owner', after]);
  });

  it('a portal demotion of one owner and the other owner demoting themselves: the second waits, then is the last owner (RC005)', async () => {
    const c = await company();
    const portal = await holding([["UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2", [c, o2]]], 'platform_admin');
    const demote = outcome(updateCompanyUserRole(c, o, 'admin', o));
    await adminBlocked();
    await portal.commit();
    expect(await demote).toBe('Cannot change role: this is the last owner of the company.');
    expect([await roleOf(c, o), await roleOf(c, o2)]).toEqual(['owner', 'admin']);
  });

  it('the last owner is neither demoted nor removed (RC005), counted by person, a case-variant row no second owner', async () => {
    const c = await company([[o, 'owner'], [o.toUpperCase(), 'owner'], [a, 'admin']]);
    expect(await outcome(updateCompanyUserRole(c, o, 'admin', o))).toBe('Cannot change role: this is the last owner of the company.');
    expect(await outcome(updateCompanyUserRole(c, o.toUpperCase(), 'admin', o))).toBe('Cannot change role: this is the last owner of the company.');
    expect(await outcome(removeCompanyUser(c, o.toUpperCase(), o))).toBe('You cannot remove yourself from the company.');
    expect(await roleOf(c, o)).toBe('owner');
  });

  it.each(['Owner ', 'OWNER', ' owner'])('a legacy owner-ish row %j is an owner\'s: an admin may not touch it; it is not the owner left behind', async (legacy) => {
    const c = await company([[o, 'owner'], [o2, legacy], [a, 'admin'], [m, 'manager']]);
    expect(await outcome(updateCompanyUserRole(c, o2, 'viewer', a))).toBe('OwnerProtectedError');
    expect(await outcome(removeCompanyUser(c, o2, a))).toBe('OwnerProtectedError');
    expect(await outcome(updateCompanyUserRole(c, o, 'admin', o))).toBe('Cannot change role: this is the last owner of the company.');
    expect(await outcome(updateCompanyUserRole(c, o2, 'admin', o))).toBe('ok');
  });

  it('an admin manages non-owners; a viewer manages nobody; nobody removes themselves (RC006)', async () => {
    const c = await company([[o, 'owner'], [a, 'admin'], [m, 'manager'], [o2, 'viewer']]);
    expect(await outcome(updateCompanyUserRole(c, m, 'viewer', a))).toBe('ok');
    expect(await outcome(updateCompanyUserRole(c, m, 'admin', o2))).toBe('MemberRoleForbiddenError');
    expect(await outcome(removeCompanyUser(c, a, a))).toBe('You cannot remove yourself from the company.');
    expect(await outcome(removeCompanyUser(c, m, a))).toBe('ok');
    expect([await roleOf(c, m), await roleOf(c, a)]).toEqual([null, 'admin']);
  });
});
