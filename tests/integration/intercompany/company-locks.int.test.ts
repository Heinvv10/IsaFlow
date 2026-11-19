/**
 * Intercompany (1002): the company locks (one row per company) and the slots table are closed to every app role, and the old public
 * advisory key is no longer a lock anyone can hold to stall a tenant.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, outcome, pairOf, setup, U, wipeConnections } from './intercompany.helpers';
import { makeRace } from './group-race.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const { openSession, LEAVE } = makeRace(pool);

beforeAll(() => setup(pool), 60000);
afterAll(async () => {
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
  await cleanup(pool);
});
beforeEach(async () => {
  await wipeConnections(pool);
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
});

describe('intercompany_company_locks', () => {
  it('is owned by migration_admin, forced RLS with a deny policy, and no privilege for any app role or PUBLIC (nor the slots table)', async () => {
    await expect(pool.query('INSERT INTO intercompany_company_locks(company_id) VALUES ($1), ($1)', [co.A])).rejects.toMatchObject({ code: '23505' });
    const t = (await pool.query("SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity, (SELECT count(*)::int FROM pg_policies WHERE tablename = 'intercompany_company_locks') AS policies FROM pg_class WHERE relname = 'intercompany_company_locks'")).rows[0];
    expect(t).toEqual({ owner: 'migration_admin', relrowsecurity: true, relforcerowsecurity: true, policies: 1 });
    for (const role of ['app_user', 'app_service', 'public']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        for (const table of ['intercompany_company_locks', 'intercompany_document_slots']) {
          expect((await pool.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, `public.${table}`, priv])).rows[0].ok, `${role} ${priv} ${table}`).toBe(false);
        }
      }
    }
    // the slots table (link documents) is closed the same way, and says so in a policy as well (the RLS census wants one)
    const slots = (await pool.query("SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity, (SELECT count(*)::int FROM pg_policies WHERE tablename = 'intercompany_document_slots') AS policies FROM pg_class WHERE relname = 'intercompany_document_slots'")).rows[0];
    expect(slots).toEqual({ owner: 'migration_admin', relrowsecurity: true, relforcerowsecurity: true, policies: 1 });
    // the internal helpers that take the locks are for migration_admin only
    for (const fn of ['public.intercompany_lock_companies(uuid[], boolean)', 'public.intercompany_topology_companies(uuid[], uuid[], uuid[])', 'public.intercompany_topology_candidates(uuid[])',
      'public.intercompany_group_members(uuid, uuid[])', 'public.intercompany_revoke_for_change(uuid[], uuid[], boolean)']) {
      for (const role of ['app_user', 'app_service', 'public']) {
        expect((await pool.query('SELECT has_function_privilege($1, $2, $3) AS ok', [role, fn, 'EXECUTE'])).rows[0].ok, `${role} ${fn}`).toBe(false);
      }
      expect((await pool.query('SELECT has_function_privilege($1, $2, $3) AS ok', ['migration_admin', fn, 'EXECUTE'])).rows[0].ok).toBe(true);
    }
    // the two trigger functions that create / take lock rows are registered definers no app role can execute
    for (const fn of ['public.intercompany_company_lock_row()', 'public.intercompany_group_member_joined()', 'public.intercompany_group_deactivated()', 'public.intercompany_group_membership_changed()']) {
      for (const role of ['app_user', 'app_service', 'public']) {
        expect((await pool.query('SELECT has_function_privilege($1, $2, $3) AS ok', [role, fn, 'EXECUTE'])).rows[0].ok, `${role} ${fn}`).toBe(false);
      }
      expect((await pool.query('SELECT count(*)::int AS n FROM app_definer_reviews r JOIN pg_proc p ON r.signature = p.oid::regprocedure::text WHERE p.oid = $1::regprocedure AND r.body_md5 = app_definer_hash(p.oid)', [fn])).rows[0].n).toBe(1);
    }
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
  });

  it('app_user (any user, any claims, none) cannot lock, read or write it', async () => {
    const statements = [
      'SELECT 1 FROM intercompany_company_locks FOR SHARE', 'SELECT 1 FROM intercompany_company_locks FOR UPDATE', 'SELECT 1 FROM intercompany_company_locks',
      'UPDATE intercompany_company_locks SET company_id = company_id', 'DELETE FROM intercompany_company_locks', 'INSERT INTO intercompany_company_locks(company_id) VALUES (gen_random_uuid())',
      'LOCK TABLE intercompany_company_locks IN ACCESS EXCLUSIVE MODE',
    ];
    for (const user of [U.x, U.a, U.ab]) {
      await asAppUser(pool, user, co.A, async (q) => {
        for (const text of statements) expect((await outcome(q, text)).slice(0, 5), `${user}: ${text}`).toBe('42501');
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      for (const text of statements) expect((await outcome(client, text)).slice(0, 5), `no claims: ${text}`).toBe('42501');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('a session that holds the OLD public advisory key (session-level, until it disconnects) stalls nobody', async () => {
    const stranger = await pool.connect();
    const [low, high] = pairOf(co.A, co.B);
    const writer = await openSession(U.ab, low);
    try {
      const key = "pg_catalog.hashtextextended('isaflow.intercompany.group_topology', 0)";
      await stranger.query(`SELECT pg_catalog.pg_advisory_lock(${key})`);
      await writer.query("SET LOCAL lock_timeout = '2s'");
      const id = (await writer.query(`INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id)
        VALUES ($1, $2, 'group', 'active', $1) RETURNING id`, [low, high])).rows[0].id as string;
      expect(id).toBeTruthy();
      await writer.query('COMMIT');
      const t0 = Date.now();
      await pool.query(LEAVE, [co.G, co.B]);                     // the leave (superuser, as the trigger's table owner) is not stalled either
      expect(Date.now() - t0).toBeLessThan(2000);
      expect((await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [id])).rows[0].status).toBe('revoked');
    } finally {
      await stranger.query('SELECT pg_catalog.pg_advisory_unlock_all()').catch(() => undefined);
      stranger.release();
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
  });
});
