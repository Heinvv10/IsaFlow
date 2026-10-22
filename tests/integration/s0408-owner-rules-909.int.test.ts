// Migration 909 (audit S-04/S-08 follow-ups A and B), by raw SQL as the real
// roles, the services bypassed.
//
// A: no writer but app_user (platform_admin — the admin site — or any other
//    non-superuser role) removes or demotes a company's last owner: RC011.
//    A hard-deleted company's members go with it (FK cascade), unrefused.
// B: as app_user, only an owner changes or removes an owner row: RC010.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import { asRole, cleanup, outcome, ownersOf, roleOf, seedCompany } from './s0408-owner-rules.helpers';

assertDisposableDb('909 seeds companies and members.');

const id = () => crypto.randomUUID();
const DEL = 'DELETE FROM company_users WHERE company_id = $1 AND user_id = $2';
const DEMOTE = "UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2";

describe.skipIf(!isDisposableDb(process.env.DATABASE_URL))('909 — owner rules in company_users_role_guard', () => {
  let pool: Pool;
  const companies: string[] = [];

  beforeAll(() => { pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 }); });
  afterAll(async () => { await cleanup(pool, companies); await pool.end(); });

  describe('A — the last owner, outside app_user', () => {
    it.each(['platform_admin', 'migration_admin'] as const)('%s cannot remove or demote the only owner (RC011)', async (role) => {
      const [o, v] = [id(), id()];
      const c = await seedCompany(pool, companies, [[o, 'owner'], [v, 'viewer']]);
      expect(await outcome(asRole(pool, role, c, DEL, [c, o]))).toBe('RC011');
      expect(await outcome(asRole(pool, role, c, DEMOTE, [c, o]))).toBe('RC011');
      expect(await roleOf(pool, c, o)).toBe('owner');
    });

    it('a non-superuser cannot move the only owner\'s row to another company or person (RC011)', async () => {
      const [o, x] = [id(), id()];
      const c = await seedCompany(pool, companies, [[o, 'owner']]);
      const d = await seedCompany(pool, companies, []);
      expect(await outcome(asRole(pool, 'migration_admin', c,
        'UPDATE company_users SET company_id = $3 WHERE company_id = $1 AND user_id = $2', [c, o, d]))).toBe('RC011');
      expect(await outcome(asRole(pool, 'migration_admin', c,
        'UPDATE company_users SET user_id = $3 WHERE company_id = $1 AND user_id = $2', [c, o, x]))).toBe('RC011');
      expect(await ownersOf(pool, c)).toEqual([o]);
    });

    it('the refusal names the rule in words the admin site shows', async () => {
      const o = id();
      const c = await seedCompany(pool, companies, [[o, 'owner']]);
      await expect(asRole(pool, 'platform_admin', c, DEL, [c, o]))
        .rejects.toThrow("This user is the company's only owner. Make someone else owner first.");
    });

    it.each(['platform_admin', 'migration_admin'] as const)('%s removes or demotes an owner when another owner remains', async (role) => {
      const [o1, o2, o3] = [id(), id(), id()];
      const c = await seedCompany(pool, companies, [[o1, 'owner'], [o2, 'owner'], [o3, 'owner']]);
      await asRole(pool, role, c, DEL, [c, o1]);
      await asRole(pool, role, c, DEMOTE, [c, o2]);
      expect(await ownersOf(pool, c)).toEqual([o3]);
      expect(await outcome(asRole(pool, role, c, DEL, [c, o3]))).toBe('RC011');
    });

    it("an owner's case-variant second row is still that person: removing one does not count as another owner", async () => {
      const o = id();
      const c = await seedCompany(pool, companies, [[o, 'owner'], [o.toUpperCase(), 'owner']]);
      expect(await outcome(asRole(pool, 'platform_admin', c, DEL, [c, o]))).toBe('RC011');
    });

    it("deleting a user from every company is refused whole when they are a company's only owner", async () => {
      const [u, other] = [id(), id()];
      const shared = await seedCompany(pool, companies, [[u, 'owner'], [other, 'owner']]);
      const sole = await seedCompany(pool, companies, [[u, 'owner'], [other, 'admin']]);
      const member = await seedCompany(pool, companies, [[other, 'owner'], [u, 'viewer']]);
      expect(await outcome(asRole(pool, 'platform_admin', sole, 'DELETE FROM company_users WHERE user_id = $1', [u]))).toBe('RC011');
      expect([await roleOf(pool, shared, u), await roleOf(pool, sole, u), await roleOf(pool, member, u)])
        .toEqual(['owner', 'owner', 'viewer']);
    });

    // The FK cascade runs as company_users' owner. On production that owner is
    // not a superuser; on the fixture it is, which the superuser exemption
    // would hide, so the owner is switched (and switched back by the ROLLBACK).
    it('a company hard delete takes its only owner with it (FK cascade run by a non-superuser table owner)', async () => {
      for (const role of ['migration_admin', 'platform_admin'] as const) {
        const o = id();
        const c = await seedCompany(pool, companies, [[o, 'owner']]);
        const cl = await pool.connect();
        try {
          await cl.query('BEGIN');
          await cl.query('ALTER TABLE company_users OWNER TO migration_admin');
          await cl.query(`SET LOCAL ROLE ${role}`);
          await cl.query('DELETE FROM companies WHERE id = $1', [c]);
          expect((await cl.query('SELECT count(*)::int AS n FROM company_users WHERE company_id = $1', [c])).rows[0].n).toBe(0);
        } finally {
          await cl.query('ROLLBACK');
          cl.release();
        }
        expect(await roleOf(pool, c, o)).toBe('owner');
      }
    });

    it('a superuser is exempt (test cleanups and seed scripts on dev and CI)', async () => {
      const o = id();
      const c = await seedCompany(pool, companies, [[o, 'owner']]);
      const su = (await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper as boolean;
      expect(su).toBe(true);
      await pool.query(DEL, [c, o]);
      expect(await roleOf(pool, c, o)).toBeNull();
    });

    it('outside READ COMMITTED an owner removal is refused (40001), even with another owner', async () => {
      const [o1, o2] = [id(), id()];
      const c = await seedCompany(pool, companies, [[o1, 'owner'], [o2, 'owner']]);
      for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
        expect(await outcome(asRole(pool, 'platform_admin', c, DEL, [c, o1], undefined, iso))).toBe('40001');
      }
      expect(await ownersOf(pool, c)).toEqual([o1, o2].sort());
    });

    it('platform_admin still manages non-owners and adds members', async () => {
      const [o, v, x] = [id(), id(), id()];
      const c = await seedCompany(pool, companies, [[o, 'owner'], [v, 'viewer']]);
      await asRole(pool, 'platform_admin', c, "UPDATE company_users SET role = 'accountant' WHERE company_id = $1 AND user_id = $2", [c, v]);
      await asRole(pool, 'platform_admin', c, "INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'viewer')", [c, x]);
      await asRole(pool, 'platform_admin', c, DEL, [c, v]);
      expect([await roleOf(pool, c, v), await roleOf(pool, c, x)]).toEqual([null, 'viewer']);
    });
  });

  describe('B — as app_user, only an owner changes or removes an owner', () => {
    it('an admin cannot demote or remove an owner, even with another owner left (RC010)', async () => {
      const [o1, o2, a] = [id(), id(), id()];
      const c = await seedCompany(pool, companies, [[o1, 'owner'], [o2, 'owner'], [a, 'admin']]);
      expect(await outcome(asRole(pool, 'app_user', c, DEMOTE, [c, o1], a))).toBe('RC010');
      expect(await outcome(asRole(pool, 'app_user', c, "UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [c, o1], a))).toBe('RC010');
      expect(await outcome(asRole(pool, 'app_user', c, DEL, [c, o1], a))).toBe('RC010');
      expect(await ownersOf(pool, c)).toEqual([o1, o2].sort());
    });

    it('an owner demotes and removes another owner', async () => {
      const [o1, o2, o3] = [id(), id(), id()];
      const c = await seedCompany(pool, companies, [[o1, 'owner'], [o2, 'owner'], [o3, 'owner']]);
      await asRole(pool, 'app_user', c, DEMOTE, [c, o2], o1);
      await asRole(pool, 'app_user', c, DEL, [c, o3], o1);
      expect([await roleOf(pool, c, o2), await roleOf(pool, c, o3)]).toEqual(['admin', null]);
    });

    it('the last owner rule still holds for an owner (RC005), and self-removal stays RC006', async () => {
      const [o, a] = [id(), id()];
      const c = await seedCompany(pool, companies, [[o, 'owner'], [a, 'admin']]);
      expect(await outcome(asRole(pool, 'app_user', c, DEMOTE, [c, o], o))).toBe('RC005');
      expect(await outcome(asRole(pool, 'app_user', c, DEL, [c, o], o))).toBe('RC006');
    });

    it('an admin still manages every non-owner (admin → manager, remove a viewer)', async () => {
      const [o, a, a2, v] = [id(), id(), id(), id()];
      const c = await seedCompany(pool, companies, [[o, 'owner'], [a, 'admin'], [a2, 'admin'], [v, 'viewer']]);
      await asRole(pool, 'app_user', c, "UPDATE company_users SET role = 'manager' WHERE company_id = $1 AND user_id = $2", [c, a2], a);
      await asRole(pool, 'app_user', c, DEL, [c, v], a);
      expect([await roleOf(pool, c, a2), await roleOf(pool, c, v)]).toEqual(['manager', null]);
    });

    it("an admin's multi-row delete that reaches an owner row is refused whole", async () => {
      const [o1, o2, a, v] = [id(), id(), id(), id()];
      const c = await seedCompany(pool, companies, [[o1, 'owner'], [o2, 'owner'], [a, 'admin'], [v, 'viewer']]);
      expect(await outcome(asRole(pool, 'app_user', c,
        'DELETE FROM company_users WHERE company_id = $1 AND user_id = ANY($2)', [c, [v, o2]], a))).toBe('RC010');
      expect([await roleOf(pool, c, v), await roleOf(pool, c, o2)]).toEqual(['viewer', 'owner']);
    });
  });
});
