/**
 * Intercompany P1 (999p): the connection row itself. Pair settings (mode, cut-over, interest) live here and need a
 * write role in BOTH companies; the status moves only by the legal steps; a group connection lives only while both
 * companies are current members of one group (definer helper + group-leave trigger); an external one cannot be
 * created yet. Trigger-level rules are tested as the table owner (no column grant or RLS in the way) so the
 * trigger's OWN refusal is what is asserted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { dataOf, messageOf } from '../r035-pr2.helpers';
import {
  api, asAppUser, asOwner, cleanup, co, count, outcome, pairOf, plantConnection, plantExternal, R, setup, U, wipeConnections, withoutTrigger,
} from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

const row = async (cid = id) => (await pool.query('SELECT * FROM intercompany_connections WHERE id = $1', [cid])).rows[0];
const leaveGroup = (company: string) => pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, company]);

describe('the pair settings', () => {
  it('start as cash, no cut-over, no interest, and a user who can write in both sets them through the route', async () => {
    expect(await row()).toMatchObject({ settlement_mode: 'cash', cutover_date: null, interest_rate_pct: null });
    const res = await api.settings(U.ab, co.A, id, { settlementMode: 'loan', cutoverDate: '2026-12-01', interestRatePct: 10.5 });
    expect(res.state.statusCode).toBe(200);
    expect(dataOf<{ settings: unknown }>(res).settings).toEqual({ settlementMode: 'loan', cutoverDate: '2026-12-01', interestRatePct: 10.5 });
    expect(await row()).toMatchObject({ settlement_mode: 'loan', interest_rate_pct: '10.5000' });
    // both parties read the same pair facts
    const asB = dataOf<{ items: Array<{ settings: { settlementMode: string } }> }>(await api.list(U.b, co.B)).items[0]!;
    expect(asB.settings.settlementMode).toBe('loan');
  });

  it.each([
    ['owner of A only', () => U.a, () => co.A],
    ['owner of B only', () => U.b, () => co.B],
    ['owner of A, viewer of B', () => U.avb, () => co.A],
    ['viewer of A', () => U.va, () => co.A],
  ])('%s is refused (403) and nothing changes', async (_n, user, company) => {
    const res = await api.settings(user(), company(), id, { settlementMode: 'loan' });
    expect(res.state.statusCode).toBe(403);
    expect((await row()).settlement_mode).toBe('cash');
  });

  it('a manager of both companies may (manager is a write role)', async () => {
    expect((await api.settings(U.mab, co.A, id, { cutoverDate: '2026-12-01' })).state.statusCode).toBe(200);
  });

  it.each([
    ['a number for the mode', { settlementMode: 1 }], ['an unknown mode', { settlementMode: 'barter' }],
    ['an impossible date', { cutoverDate: '2026-02-30' }], ['interest 100.5', { interestRatePct: 100.5 }],
    ['interest as text', { interestRatePct: '5' }], ['a side field', { customerId: null }], ['an empty body', {}],
  ])('%s is a 400', async (_n, body) => {
    expect((await api.settings(U.ab, co.A, id, body)).state.statusCode).toBe(400);
  });

  it('a non-UUID id is 400, an unknown or foreign connection 404, a revoked one 409', async () => {
    expect((await api.settings(U.ab, co.A, 'nope', { cutoverDate: null })).state.statusCode).toBe(400);
    expect((await api.settings(U.ab, co.A, crypto.randomUUID(), { cutoverDate: null })).state.statusCode).toBe(404);
    expect((await api.settings(U.c, co.C, id, { cutoverDate: null })).state.statusCode).toBe(404);
    await api.revoke(U.ab, co.A, id);
    const res = await api.settings(U.ab, co.A, id, { cutoverDate: '2026-12-01' });
    expect(res.state.statusCode).toBe(409);
    expect(messageOf(res)).toMatch(/revoked/i);
  });

  it('the database refuses a write role in only one company, and a revoked connection, whatever the code does', async () => {
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET settlement_mode = 'loan' WHERE id = $1", [id])).toBe(R.settingsWriteBoth);
    });
    await asAppUser(pool, U.avb, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET cutover_date = '2026-12-01' WHERE id = $1", [id])).toBe(R.settingsWriteBoth);
    });
    await asAppUser(pool, U.ab, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET settlement_mode = 'loan' WHERE id = $1", [id])).toBe('ok');
      expect(await outcome(q, "UPDATE intercompany_connections SET interest_rate_pct = 100.0001 WHERE id = $1", [id]))
        .toBe('23514: new row for relation "intercompany_connections" violates check constraint "intercompany_connections_interest_rate_pct_check"');
      expect(await outcome(q, "UPDATE intercompany_connections SET settlement_mode = 'barter' WHERE id = $1", [id]))
        .toBe('23514: new row for relation "intercompany_connections" violates check constraint "intercompany_connections_settlement_mode_check"');
    });
    await asOwner(pool, U.ab, co.A, async (q) => {
      await q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]);
      expect(await outcome(q, "UPDATE intercompany_connections SET cutover_date = '2026-12-01' WHERE id = $1", [id])).toBe(R.settingsRevoked);
    });
  });

  it("an external connection's settings are refused by the database", async () => {
    const ext = await plantExternal(pool, co.A, co.C, 'active', U.ac);
    await asOwner(pool, U.ac, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET settlement_mode = 'loan' WHERE id = $1", [ext])).toBe(R.settingsExternal);
    });
  });
});

describe('creating a connection (database)', () => {
  const INSERT = `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id) VALUES ($1, $2, $3, $4, $1)`;

  it('an external connection cannot be created until P6, even by a superuser', async () => {
    const [low, high] = pairOf(co.A, co.C);
    await asAppUser(pool, U.ac, low, async (q) => {
      expect(await outcome(q, INSERT, [low, high, 'external', 'pending'])).toBe(R.externalNotYet);
    });
    await asOwner(pool, U.ac, low, async (q) => {
      expect(await outcome(q, INSERT, [low, high, 'external', 'pending'])).toBe(R.externalNotYet);
    });
  });

  it('a group connection is created active, and only a pending or revoked row is anything else', async () => {
    await pool.query('DELETE FROM intercompany_connections');
    const [low, high] = pairOf(co.A, co.B);
    await asAppUser(pool, U.ab, low, async (q) => {
      expect(await outcome(q, INSERT, [low, high, 'group', 'pending'])).toBe(R.groupCreatedActive);
      expect(await outcome(q, INSERT, [low, high, 'group', 'revoked'])).toBe(R.groupCreatedActive);
      expect(await outcome(q, INSERT, [low, high, 'group', 'active'])).toBe('ok');
    });
  });

  it('needs a write role in both companies and a signed-in user, and the stamps are the session user\'s', async () => {
    await pool.query('DELETE FROM intercompany_connections');
    const [low, high] = pairOf(co.A, co.B);
    await asAppUser(pool, U.a, low, async (q) => {
      expect(await outcome(q, INSERT, [low, high, 'group', 'active'])).toBe(R.needsWriteBoth);
    });
    await asOwner(pool, null, low, async (q) => {
      expect(await outcome(q, INSERT, [low, high, 'group', 'active'])).toBe(R.needsWriteBoth);
    });
    await asOwner(pool, U.ab, low, async (q) => {
      // what the client sends for the stamps is overwritten
      await q.query(`INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id, invited_by, accepted_by, accepted_at, revoked_by, revoked_at, created_at)
                     VALUES ($1, $2, 'group', 'active', $1, 'someone-else', 'someone-else', now(), 'x', now(), '2001-01-01')`, [low, high]);
    }, true);
    const r = await pool.query('SELECT invited_by, accepted_by, revoked_by, revoked_at, created_at > now() - interval \'1 minute\' AS fresh FROM intercompany_connections');
    expect(r.rows[0]).toEqual({ invited_by: U.ab, accepted_by: U.ab, revoked_by: null, revoked_at: null, fresh: true });
  });

  it('the pair is unique among live rows only: a second live row is refused, a revoked one is not in the way', async () => {
    const [low, high] = pairOf(co.A, co.B);
    await asAppUser(pool, U.ab, low, async (q) => {
      expect(await outcome(q, INSERT, [low, high, 'group', 'active']))
        .toBe('23505: duplicate key value violates unique constraint "intercompany_connections_live_pair_uq"');
    });
    await asOwner(pool, U.ab, low, async (q) => {
      await q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]);
      expect(await outcome(q, INSERT, [low, high, 'group', 'active'])).toBe('ok');
    });
  });

  it('the pair is ordered (low < high)', async () => {
    const [low, high] = pairOf(co.A, co.B);
    await pool.query('DELETE FROM intercompany_connections');
    await asOwner(pool, U.ab, high, async (q) => {
      expect(await outcome(q, `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id) VALUES ($2, $1, 'group', 'active', $2)`, [low, high]))
        .toBe('23514: new row for relation "intercompany_connections" violates check constraint "intercompany_connections_ordered"');
    });
  });
});

describe('the status moves only by the legal steps (trigger, as owner)', () => {
  it('only the status and the settings can change; the parties, the kind and the inviter cannot', async () => {
    await asOwner(pool, U.ab, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET kind = 'external' WHERE id = $1", [id])).toBe(R.connImmutable);
      expect(await outcome(q, 'UPDATE intercompany_connections SET invited_by = $2 WHERE id = $1', [id, 'someone'])).toBe(R.connImmutable);
      expect(await outcome(q, 'UPDATE intercompany_connections SET invited_by_company_id = company_high_id WHERE id = $1', [id])).toBe(R.connImmutable);
      expect(await outcome(q, "UPDATE intercompany_connections SET created_at = '2001-01-01' WHERE id = $1", [id])).toBe(R.connImmutable);
      expect(await outcome(q, 'UPDATE intercompany_connections SET company_low_id = company_high_id, company_high_id = company_low_id WHERE id = $1', [id]))
        .toMatch(/^23514: /);
    });
  });

  it('a status change needs a signed-in user; the stamps are server-side', async () => {
    await asOwner(pool, null, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id])).toBe(R.statusNeedsUser);
    });
    await asOwner(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'revoked', revoked_by = 'x' WHERE id = $1", [id])).toBe('ok');
    }, true);
    expect(await row()).toMatchObject({ status: 'revoked', revoked_by: U.a });
  });

  it('a revoked pending/active row only goes back by the legal steps', async () => {
    await asOwner(pool, U.ab, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'pending' WHERE id = $1", [id])).toBe('23514: a connection cannot go from active to pending');
    });
  });

  it('pending -> active is the accept: only the OTHER company, and only a party, accepts', async () => {
    const ext = await plantExternal(pool, co.A, co.C, 'pending', U.ac);
    const [low, high] = pairOf(co.A, co.C);
    const accept = "UPDATE intercompany_connections SET status = 'active' WHERE id = $1";
    await asOwner(pool, U.ac, low, async (q) => { expect(await outcome(q, accept, [ext])).toBe(R.inviterAccepts); });
    await asOwner(pool, U.ab, co.B, async (q) => { expect(await outcome(q, accept, [ext])).toBe(R.partyAccepts); });
    await asOwner(pool, U.ac, high, async (q) => { expect(await outcome(q, accept, [ext])).toBe('ok'); }, true);
    expect(await row(ext)).toMatchObject({ status: 'active', accepted_by: U.ac });
  });

  it('a revoked EXTERNAL connection is invited again, never re-activated', async () => {
    const ext = await plantExternal(pool, co.A, co.C, 'revoked', U.ac);
    await asOwner(pool, U.ac, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [ext])).toBe(R.externalReinvite);
    });
  });

  it('a revoked GROUP connection re-activates only with a write role in both and both still in one group', async () => {
    await asOwner(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [id])).toBe(R.reactivateWriteBoth);
    });
    await leaveGroup(co.B);
    await asAppUser(pool, U.ab, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [id])).toBe(R.needsOneGroup);
    });
    await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    await asAppUser(pool, U.ab, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [id])).toBe('ok');
    }, true);
    expect(await row()).toMatchObject({ status: 'active', revoked_by: null, accepted_by: U.ab });
  });

  it('the re-activation UPDATE finds exactly one revoked row and cannot race (route)', async () => {
    await api.revoke(U.a, co.A, id);
    const [first, second] = await Promise.all([api.create(U.ab, co.A, { partnerCompanyId: co.B }), api.create(U.ab, co.B, { partnerCompanyId: co.A })]);
    expect([first.state.statusCode, second.state.statusCode].sort()).toEqual([201, 409]);
    expect(await count(pool, "SELECT COUNT(*)::int AS n FROM intercompany_connections WHERE status = 'active'")).toBe(1);
  });
});

describe('a group connection lives only while both companies are current members of one group', () => {
  it('the helper answers regardless of the caller\'s RLS: a user of neither company gets the true answer, and false for non-members', async () => {
    const ask = (q: import('pg').PoolClient, a: string, b: string) => q.query('SELECT public.intercompany_in_one_group($1, $2) AS ok', [a, b]).then((r) => r.rows[0].ok as boolean);
    await asAppUser(pool, U.c, co.C, async (q) => {
      expect(await ask(q, co.A, co.B)).toBe(true);       // C cannot read company_group_members rows of G, yet the answer is true
      expect(await ask(q, co.A, co.C)).toBe(false);      // different groups
      expect(await ask(q, co.A, co.A)).toBe(false);
      expect(await ask(q, co.A, crypto.randomUUID())).toBe(false);
    });
    await leaveGroup(co.B);
    await asAppUser(pool, U.c, co.C, async (q) => { expect(await ask(q, co.A, co.B)).toBe(false); });
  });

  it('the helper is executable by the app roles only, with a pinned search path, and is a registered definer', async () => {
    const f = (await pool.query(
      `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
              has_function_privilege('app_service', p.oid, 'EXECUTE') AS app_service,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              (SELECT count(*) FROM app_definer_reviews r WHERE r.signature = p.oid::regprocedure::text AND r.body_md5 = app_definer_hash(p.oid)) AS reviewed
         FROM pg_proc p WHERE p.proname = 'intercompany_in_one_group'`)).rows[0];
    expect(f).toMatchObject({ prosecdef: true, owner: 'migration_admin', app_user: true, app_service: true, public_exec: false, reviewed: '1' });
    expect(f.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
  });

  it('a company leaving the group revokes its active group connections, stamped by the system; one that stays in another shared group keeps it', async () => {
    await leaveGroup(co.B);
    expect(await row()).toMatchObject({ status: 'revoked', revoked_by: 'system:group-membership' });
    expect((await row()).revoked_at).toBeInstanceOf(Date);
  });

  it('a second shared group keeps the connection when one membership ends; deleting the last membership revokes it', async () => {
    const g2 = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC group G2')", [g2]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [g2, co.A, co.B]);
    try {
      await leaveGroup(co.B);
      expect((await row()).status).toBe('active');
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = $2', [g2, co.B]);
      expect(await row()).toMatchObject({ status: 'revoked', revoked_by: 'system:group-membership' });
    } finally {
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [g2]);
    }
  });

  it('an app_user session ending a membership revokes too (the definer reaches rows its RLS hides), and a non-group connection is untouched', async () => {
    const ext = await plantExternal(pool, co.A, co.C, 'active', U.ac);
    await asAppUser(pool, U.ab, co.A, async (q) => {
      await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.A]);
    }, true);
    expect((await row()).status).toBe('revoked');
    expect((await row(ext)).status).toBe('active');
  });

  it('the group-leave trigger fires on left_date and on DELETE, and its function is a registered definer', async () => {
    const t = (await pool.query(
      `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE t.tgrelid = 'company_group_members'::regclass AND NOT t.tgisinternal AND t.tgname = 'trg_intercompany_group_membership'`)).rows[0];
    expect(t.def).toMatch(/AFTER (UPDATE OF [a-z_, ]+|DELETE|UPDATE OF [a-z_, ]+ OR DELETE)/);
    expect(t.def).toContain('left_date');
    const f = (await pool.query(
      `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
              (SELECT count(*) FROM app_definer_reviews r WHERE r.signature = p.oid::regprocedure::text AND r.body_md5 = app_definer_hash(p.oid)) AS reviewed
         FROM pg_proc p WHERE p.proname = 'intercompany_group_membership_changed'`)).rows[0];
    expect(f).toMatchObject({ prosecdef: true, owner: 'migration_admin', reviewed: '1' });
  });

  it('while a company has left, its side and message writes are refused (trigger disabled to reach the guards)', async () => {
    await pool.query("INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id) VALUES ($1, $2, $3)", [id, co.A, co.B]);
    await withoutTrigger(pool, 'company_group_members', 'trg_intercompany_group_membership', async (q) => {
      await q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    });
    expect((await row()).status).toBe('active'); // the trigger was off
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
        VALUES ($1, $2, $3, 'invoice', 'customer_invoice', gen_random_uuid(), '{}')`, [id, co.A, co.B])).toBe(R.msgOneGroup);
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1', [id])).toBe(R.autoAcceptOneGroup);
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET auto_accept = false WHERE connection_id = $1', [id])).toBe('ok');
    });
  });
});
