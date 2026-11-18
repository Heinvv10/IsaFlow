/**
 * Intercompany (1000): a group connection lives only while both companies are current members of one ACTIVE group.
 * The helper answers for a party only; a company leaving, a group deleted by the real deleteGroup service, or a membership
 * removed revokes the connection (system stamp); the system path cannot be forged; the guards refuse the writes of a
 * connection whose group has gone, whatever reached them (the revoking triggers are switched off to get there).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { deleteGroup } from '../../../src/modules/accounting/services/reports/groupCrudService';
import {
  asAppUser, asOwner, cleanup, co, outcome, plantConnection, plantExternal, R, setup, U, wipeConnections, withoutTrigger,
} from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(async () => { await pool.query('UPDATE company_groups SET is_active = true WHERE id = ANY($1)', [[co.G, co.H]]); await cleanup(pool); });
beforeEach(async () => {
  await pool.query('UPDATE company_groups SET is_active = true WHERE id = ANY($1)', [[co.G, co.H]]);
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

const row = async (cid = id) => (await pool.query('SELECT * FROM intercompany_connections WHERE id = $1', [cid])).rows[0];
const leave = (company: string) => pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, company]);
const REVOKED_BY_SYSTEM = { status: 'revoked', revoked_by: 'system:group-membership' };
const inOneGroup = (q: PoolClient, a: string, b: string) => q.query('SELECT public.intercompany_in_one_group($1, $2) AS ok', [a, b]).then((r) => r.rows[0].ok as boolean);

describe('intercompany_in_one_group is no membership oracle', () => {
  it('answers a party, and answers false for everyone else whatever the truth is', async () => {
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await inOneGroup(q, co.A, co.B)).toBe(true);
      expect(await inOneGroup(q, co.B, co.A)).toBe(true);
      expect(await inOneGroup(q, co.A, co.C)).toBe(false);
      expect(await inOneGroup(q, co.A, co.A)).toBe(false);
      expect(await inOneGroup(q, co.A, crypto.randomUUID())).toBe(false);
    });
    // an outsider (member of C only, or of nothing) cannot learn that A and B are grouped
    await asAppUser(pool, U.c, co.C, async (q) => { expect(await inOneGroup(q, co.A, co.B)).toBe(false); });
    await asAppUser(pool, U.x, co.C, async (q) => { expect(await inOneGroup(q, co.A, co.B)).toBe(false); });
    // a user of ONE company is a party even when the session company is another of theirs
    await asAppUser(pool, U.ac, co.C, async (q) => { expect(await inOneGroup(q, co.A, co.B)).toBe(true); });
    // a worker's context (the session company, no user) is a party
    await asOwner(pool, null, co.B, async (q) => { expect(await inOneGroup(q, co.A, co.B)).toBe(true); });
    await asOwner(pool, null, co.C, async (q) => { expect(await inOneGroup(q, co.A, co.B)).toBe(false); });
  });

  it('is false once a company has left, and once the group is inactive, for a party too', async () => {
    await leave(co.B);
    await asAppUser(pool, U.a, co.A, async (q) => { expect(await inOneGroup(q, co.A, co.B)).toBe(false); });
    await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    await asAppUser(pool, U.a, co.A, async (q) => { expect(await inOneGroup(q, co.A, co.B)).toBe(true); });
    await pool.query('UPDATE company_groups SET is_active = false WHERE id = $1', [co.G]);
    await asAppUser(pool, U.a, co.A, async (q) => { expect(await inOneGroup(q, co.A, co.B)).toBe(false); });
  });

  it('is a registered definer with a pinned path, executable by the app roles only; the internal check is for migration_admin alone', async () => {
    const f = (await pool.query(
      `SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user, has_function_privilege('app_service', p.oid, 'EXECUTE') AS app_service,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec, has_function_privilege('migration_admin', p.oid, 'EXECUTE') AS admin,
              (SELECT count(*) FROM app_definer_reviews r WHERE r.signature = p.oid::regprocedure::text AND r.body_md5 = app_definer_hash(p.oid)) AS reviewed
         FROM pg_proc p WHERE p.proname IN ('intercompany_in_one_group', 'intercompany_document_exists_as_writer', 'intercompany_group_membership_changed', 'intercompany_shared_group')
        ORDER BY p.proname`)).rows;
    const by = Object.fromEntries(f.map((r) => [r.proname, r]));
    for (const n of ['intercompany_in_one_group', 'intercompany_document_exists_as_writer']) {
      expect(by[n], n).toMatchObject({ prosecdef: true, owner: 'migration_admin', app_user: true, app_service: true, public_exec: false, reviewed: '1' });
      expect(by[n].proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    }
    expect(by.intercompany_group_membership_changed).toMatchObject({ prosecdef: true, owner: 'migration_admin', app_user: false, public_exec: false, reviewed: '1' });
    expect(by.intercompany_group_membership_changed.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    expect(by.intercompany_shared_group).toMatchObject({ prosecdef: false, app_user: false, public_exec: false, admin: true });
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
  });
});

describe('a company leaving a group takes its group connections with it', () => {
  it('revokes, stamped by the system, when the leaving company is the low one or the high one, and keeps a connection of other companies', async () => {
    const other = await plantExternal(pool, co.A, co.C, 'active', U.ac);
    await leave(co.B);
    expect(await row()).toMatchObject(REVOKED_BY_SYSTEM);
    expect((await row()).revoked_at).toBeInstanceOf(Date);
    expect((await row(other)).status).toBe('active');
    await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [id]), true);
    await leave(co.A);
    expect(await row()).toMatchObject(REVOKED_BY_SYSTEM);
    expect((await row(other)).status).toBe('active');   // an external connection of A is not a group connection: not touched
  });

  it("an app_user session ending the membership revokes too (the definer reaches rows its RLS hides); the stamp is still the system's", async () => {
    await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.A]), true);
    expect(await row()).toMatchObject(REVOKED_BY_SYSTEM);
  });

  it('a second shared group keeps the connection when one membership ends; deleting the last shared membership revokes it', async () => {
    const g2 = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC group G2')", [g2]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [g2, co.A, co.B]);
    try {
      await leave(co.B);
      expect((await row()).status).toBe('active');
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = $2', [g2, co.B]);
      expect(await row()).toMatchObject(REVOKED_BY_SYSTEM);
    } finally {
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [g2]);
    }
  });

  it('the triggers are on left_date and DELETE of the members and on is_active and DELETE of the groups', async () => {
    const defs = (await pool.query(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
        WHERE NOT t.tgisinternal AND t.tgname IN ('trg_intercompany_group_membership', 'trg_intercompany_group_deactivated') ORDER BY 1`)).rows;
    const by = Object.fromEntries(defs.map((d) => [d.tgname, d.def as string]));
    expect(by.trg_intercompany_group_membership).toMatch(/AFTER (DELETE OR UPDATE OF left_date, company_id, group_id|UPDATE OF left_date, company_id, group_id OR DELETE) ON (public\.)?company_group_members/);
    expect(by.trg_intercompany_group_deactivated).toMatch(/AFTER (DELETE OR UPDATE OF is_active|UPDATE OF is_active OR DELETE) ON (public\.)?company_groups/);
  });
});

describe('a deleted group takes its connections with it', () => {
  it('the real deleteGroup service (is_active = false) revokes the group connection, stamped by the system', async () => {
    await deleteGroup(co.G);
    expect((await pool.query('SELECT is_active FROM company_groups WHERE id = $1', [co.G])).rows[0].is_active).toBe(false);
    expect(await row()).toMatchObject(REVOKED_BY_SYSTEM);
  });

  it('an unrelated group deleted leaves it alone; so does a second ACTIVE shared group', async () => {
    await deleteGroup(co.H);
    expect((await row()).status).toBe('active');
    const g2 = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC group G2')", [g2]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [g2, co.A, co.B]);
    try {
      await deleteGroup(co.G);
      expect((await row()).status).toBe('active');
      await deleteGroup(g2);
      expect(await row()).toMatchObject(REVOKED_BY_SYSTEM);
    } finally {
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [g2]);
    }
  });

  it('removing the group row revokes too (the members cascade away)', async () => {
    const g3 = crypto.randomUUID();
    await pool.query('DELETE FROM intercompany_connections');
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC group G3')", [g3]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [g3, co.A, co.B]);
    await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1', [co.G]);   // G is no longer the shared group
    const c = await plantConnection(pool, co.A, co.B);
    await pool.query('DELETE FROM company_groups WHERE id = $1', [g3]);
    expect(await row(c)).toMatchObject(REVOKED_BY_SYSTEM);
    await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
  });

  it('a revoked connection is not revived when the group is reactivated; creating it again re-activates it (route)', async () => {
    await deleteGroup(co.G);
    await pool.query('UPDATE company_groups SET is_active = true WHERE id = $1', [co.G]);
    expect((await row()).status).toBe('revoked');
  });

  it('a message and a new connection are refused while the group is inactive (the revoking trigger is off to get there)', async () => {
    await withoutTrigger(pool, 'company_groups', 'trg_intercompany_group_deactivated', (q) => q.query('UPDATE company_groups SET is_active = false WHERE id = $1', [co.G]));
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
        VALUES ($1, $2, $3, 'invoice', 'customer_invoice', gen_random_uuid(), '{}')`, [id, co.A, co.B])).toBe(R.msgOneGroup);
    });
    await pool.query('DELETE FROM intercompany_connections');
    const [low, high] = co.A < co.B ? [co.A, co.B] : [co.B, co.A];
    await asAppUser(pool, U.ab, low, async (q) => {
      expect(await outcome(q, `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id)
        VALUES ($1, $2, 'group', 'active', $1)`, [low, high])).toBe(R.needsOneGroup);
    });
  });
});

describe('the system path cannot be forged', () => {
  const REVOKE = "UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1";
  const FLAG = "SELECT set_config('app.intercompany_system_revoke', 'on', true)";

  it('the flag alone does nothing: a viewer, a stranger and the table owner are all held to the user rules', async () => {
    await asAppUser(pool, U.va, co.A, async (q) => { await q.query(FLAG); expect(await outcome(q, REVOKE, [id])).toBe(R.statusWriteRole); });
    await asOwner(pool, null, co.A, async (q) => { await q.query(FLAG); expect(await outcome(q, REVOKE, [id])).toBe(R.statusNeedsUser); });
    await asOwner(pool, U.va, co.A, async (q) => { await q.query(FLAG); expect(await outcome(q, REVOKE, [id])).toBe(R.statusWriteRole); });
    expect((await row()).status).toBe('active');
  });

  it('migration_admin with the flag revokes as the system, and ONLY revokes; without the flag it is held to the user rules too', async () => {
    await asOwner(pool, null, co.A, async (q) => {
      await q.query('SET LOCAL ROLE migration_admin');
      expect(await outcome(q, REVOKE, [id])).toBe(R.statusNeedsUser);
      await q.query(FLAG);
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'pending' WHERE id = $1", [id])).toBe(R.systemOnlyRevokes);
      expect(await outcome(q, REVOKE, [id])).toBe('ok');
    }, true);
    expect(await row()).toMatchObject(REVOKED_BY_SYSTEM);
  });
});

describe('the system flag lives only inside the revoking trigger', () => {
  it('after a membership change in the same transaction the flag is gone: a later status change is held to the user rules again', async () => {
    const ext = await plantExternal(pool, co.A, co.C, 'active', U.ac);
    await asOwner(pool, null, co.A, async (q) => {
      await q.query('SET LOCAL ROLE migration_admin');
      await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
      expect((await q.query('SELECT status FROM intercompany_connections WHERE id = $1', [id])).rows[0].status).toBe('revoked');
      expect((await q.query("SELECT current_setting('app.intercompany_system_revoke', true) AS v")).rows[0].v).toBe('');
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [ext])).toBe(R.statusNeedsUser);
    });
  });
});

describe('the guards refuse the writes of a connection whose group has gone', () => {
  it('auto-accept cannot be switched on, on or off the group ending (revoking triggers off)', async () => {
    await asAppUser(pool, U.a, co.A, (q) => q.query('INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id) VALUES ($1, $2, $3)', [id, co.A, co.B]), true);
    await withoutTrigger(pool, 'company_group_members', 'trg_intercompany_group_membership', (q) =>
      q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]));
    expect((await row()).status).toBe('active');
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1', [id])).toBe(R.autoAcceptOneGroup);
      expect(await outcome(q, `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
        VALUES ($1, $2, $3, 'invoice', 'customer_invoice', gen_random_uuid(), '{}')`, [id, co.A, co.B])).toBe(R.msgOneGroup);
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET auto_accept = false WHERE connection_id = $1', [id])).toBe('ok');
    });
  });
});
