/**
 * Intercompany P1 (migration 999z), the headline guards, proved with real PostgreSQL as app_user and through the
 * real routes:
 *   1. a third company (C) cannot see, change or end a connection between A and B;
 *   2. a company cannot edit its partner's side (B cannot edit A's);
 *   3. auto-accept is refused on an external connection by the DATABASE, whoever writes;
 *   4. a group connection is refused when the two companies are not current members of one group.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { dataOf, messageOf } from '../r035-pr2.helpers';
import {
  api, asAppUser, asOwner, cleanup, co, count, outcome, pairOf, party, plantConnection, plantExternal, plantKey, plantLink, plantMessage, plantSide, R, setup, U, wipeConnections,
} from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(() => wipeConnections(pool));

const SIDE_INSERT = `INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, auto_accept)
                     VALUES ($1, $2, $3, $4)`;
const MESSAGE = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
                 VALUES ($1, $2, $3, 'invoice', 'customer_invoice', gen_random_uuid(), '{}')`;

describe('1. a third company sees and changes nothing of the A-B connection', () => {
  it('C reads no row of any of the five tables, as app_user, and the list route is empty for C', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await plantSide(pool, id, co.A, co.B);
    await plantMessage(pool, id, co.A, co.B);
    await plantLink(pool, id);
    await plantKey(pool, co.A, 'a'.repeat(64));

    const tables = ['intercompany_connections', 'intercompany_connection_sides', 'intercompany_messages', 'intercompany_document_links', 'company_connection_keys'];
    const seenByC = await asAppUser(pool, U.c, co.C, async (q) => {
      const n: Record<string, number> = {};
      for (const t of tables) n[t] = await count(q, `SELECT COUNT(*)::int AS n FROM ${t}`);
      return n;
    });
    expect(seenByC).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
    // The control: A's own session sees A's rows (the key is A's own).
    const seenByA = await asAppUser(pool, U.a, co.A, async (q) => {
      const n: Record<string, number> = {};
      for (const t of tables) n[t] = await count(q, `SELECT COUNT(*)::int AS n FROM ${t}`);
      return n;
    });
    expect(seenByA).toEqual(Object.fromEntries(tables.map((t) => [t, 1])));

    const list = await api.list(U.c, co.C);
    expect(list.state.statusCode).toBe(200);
    expect(dataOf<{ items: unknown[] }>(list).items).toEqual([]);
  });

  it('C can neither revoke the connection (route 404, SQL 0 rows) nor write into it, and the exact refusals hold', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    expect((await api.revoke(U.c, co.C, id)).state.statusCode).toBe(404);
    await asAppUser(pool, U.c, co.C, async (q) => {
      expect((await q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id])).rowCount).toBe(0);
      // C cannot see the connection, so the guard trigger (it runs before the policy's WITH CHECK) finds none.
      expect(await outcome(q, SIDE_INSERT, [id, co.A, co.B, false])).toBe(R.noNoConnection);
      expect(await outcome(q, SIDE_INSERT, [id, co.C, co.A, false])).toBe(R.noNoConnection);
      expect(await outcome(q, MESSAGE, [id, co.A, co.B])).toBe(R.noNoConnection);
    });
    expect((await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [id])).rows[0].status).toBe('active');
  });

  it("a user in A and C, with C as the session company, still sees nothing of A's connections", async () => {
    await plantConnection(pool, co.A, co.B);
    expect(await asAppUser(pool, U.ac, co.C, (q) => count(q, 'SELECT COUNT(*)::int AS n FROM intercompany_connections'))).toBe(0);
  });
});

describe("2. a company cannot edit its partner's side", () => {
  it("B's session changes no row of A's side and cannot insert one for A", async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await plantSide(pool, id, co.A, co.B, { customer_id: party.aCustomer });
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await count(q, 'SELECT COUNT(*)::int AS n FROM intercompany_connection_sides WHERE company_id = $1', [co.A])).toBe(0);
      expect((await q.query('UPDATE intercompany_connection_sides SET customer_id = NULL WHERE company_id = $1', [co.A])).rowCount).toBe(0);
      // B can see the connection, so the guard passes the shape; B's user is no writer of A, so the guard refuses (before the policy's WITH CHECK).
      expect(await outcome(q, SIDE_INSERT, [id, co.A, co.B, false])).toBe(R.sideWriteRole);
    });
    // A user who belongs to BOTH companies is still held to the session company.
    await asAppUser(pool, U.ab, co.B, async (q) => {
      expect((await q.query('UPDATE intercompany_connection_sides SET customer_id = NULL WHERE company_id = $1', [co.A])).rowCount).toBe(0);
    });
    expect((await pool.query('SELECT customer_id FROM intercompany_connection_sides WHERE company_id = $1', [co.A])).rows[0].customer_id).toBe(party.aCustomer);
  });

  it("the PUT route writes B's own side only and never A's", async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await plantSide(pool, id, co.A, co.B, { customer_id: party.aCustomer });
    const res = await api.edit(U.b, co.B, id, { customerId: party.bCustomer });
    expect(res.state.statusCode).toBe(200);
    const rows = (await pool.query('SELECT company_id, customer_id FROM intercompany_connection_sides ORDER BY customer_id')).rows;
    expect(rows).toEqual(expect.arrayContaining([
      { company_id: co.A, customer_id: party.aCustomer }, { company_id: co.B, customer_id: party.bCustomer },
    ]));
    const view = dataOf<{ items: Array<{ side: { customerId: string } }> }>(await api.list(U.b, co.B)).items[0]!;
    expect(view.side.customerId).toBe(party.bCustomer);
  });
});

describe('3. auto-accept is only for a group connection, in the database', () => {
  it('app_user: INSERT and UPDATE of auto_accept = true on an external connection are refused (23514)', async () => {
    const id = await plantExternal(pool, co.A, co.C, 'active');
    await asAppUser(pool, U.ac, co.A, async (q) => {
      expect(await outcome(q, SIDE_INSERT, [id, co.A, co.C, true])).toBe(R.autoAcceptGroupOnly);
      expect(await outcome(q, SIDE_INSERT, [id, co.A, co.C, false])).toBe('ok');
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1', [id])).toBe(R.autoAcceptGroupOnly);
    });
  });

  it('even a superuser (RLS bypassed) cannot store it: the trigger is ENABLE ALWAYS', async () => {
    const id = await plantExternal(pool, co.A, co.C, 'active');
    await asOwner(pool, U.ac, co.A, async (q) => {
      expect(await outcome(q, SIDE_INSERT, [id, co.A, co.C, true])).toBe(R.autoAcceptGroupOnly);
    });
    expect(await count(pool, 'SELECT COUNT(*)::int AS n FROM intercompany_connection_sides WHERE connection_id = $1', [id])).toBe(0);
  });

  it('the control: the same write on a GROUP connection is accepted', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, SIDE_INSERT, [id, co.A, co.B, true])).toBe('ok');
    });
  });

  it('the PUT route refuses it with 400 and writes nothing', async () => {
    const id = await plantExternal(pool, co.A, co.C, 'active');
    const res = await api.edit(U.ac, co.A, id, { autoAccept: true });
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(/group connection/i);
    expect(await count(pool, 'SELECT COUNT(*)::int AS n FROM intercompany_connection_sides WHERE connection_id = $1', [id])).toBe(0);
  });
});

describe('4. a group connection needs both companies in one group', () => {
  it('A-C (different groups) is refused by the route (400), and nothing is stored', async () => {
    const res = await api.create(U.ac, co.A, { partnerCompanyId: co.C });
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(/same company group/i);
    expect(await count(pool, 'SELECT COUNT(*)::int AS n FROM intercompany_connections')).toBe(0);
  });

  it('the database refuses the same row, written by a user who can write in both', async () => {
    const [low, high] = pairOf(co.A, co.C);
    await asAppUser(pool, U.ac, co.A, async (q) => {
      expect(await outcome(q, `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id)
        VALUES ($1, $2, 'group', 'active', $3)`, [low, high, co.A])).toBe(R.needsOneGroup);
    });
  });

  it('a company that has LEFT the group no longer qualifies, and rejoining restores it', async () => {
    await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    try {
      expect((await api.create(U.ab, co.A, { partnerCompanyId: co.B })).state.statusCode).toBe(400);
    } finally {
      await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    }
    const ok = await api.create(U.ab, co.A, { partnerCompanyId: co.B });
    expect(ok.state.statusCode).toBe(201);
    expect(dataOf<{ kind: string; status: string }>(ok)).toMatchObject({ kind: 'group', status: 'active' });
  });

  it('a user with no write role in the partner company is refused (403)', async () => {
    expect((await api.create(U.a, co.A, { partnerCompanyId: co.B })).state.statusCode).toBe(403);
    expect((await api.create(U.va, co.A, { partnerCompanyId: co.B })).state.statusCode).toBe(403);
    expect((await api.create(U.avb, co.A, { partnerCompanyId: co.B })).state.statusCode).toBe(403);
    expect(await count(pool, 'SELECT COUNT(*)::int AS n FROM intercompany_connections')).toBe(0);
  });

  it('creates an ordered pair, once; a second create is 409; either side can then revoke and re-create it', async () => {
    const res = await api.create(U.ab, co.A, { partnerCompanyId: co.B });
    expect(res.state.statusCode).toBe(201);
    const view = dataOf<{ id: string; partnerCompanyId: string; checklist: { complete: boolean } }>(res);
    expect(view.partnerCompanyId).toBe(co.B);
    expect(view.checklist.complete).toBe(false);
    const row = (await pool.query('SELECT company_low_id, company_high_id, invited_by, accepted_by FROM intercompany_connections WHERE id = $1', [view.id])).rows[0];
    expect([row.company_low_id, row.company_high_id]).toEqual(pairOf(co.A, co.B));
    expect(row.invited_by).toBe(U.ab);
    expect(row.accepted_by).toBe(U.ab);

    expect((await api.create(U.ab, co.B, { partnerCompanyId: co.A })).state.statusCode).toBe(409);
    expect((await api.revoke(U.b, co.B, view.id)).state.statusCode).toBe(200);
    expect((await pool.query('SELECT status, revoked_by FROM intercompany_connections WHERE id = $1', [view.id])).rows[0]).toEqual({ status: 'revoked', revoked_by: U.b });
    const again = await api.create(U.ab, co.B, { partnerCompanyId: co.A });
    expect(again.state.statusCode).toBe(201);
    expect(dataOf<{ id: string; status: string }>(again)).toMatchObject({ id: view.id, status: 'active' });
    expect(await count(pool, 'SELECT COUNT(*)::int AS n FROM intercompany_connections')).toBe(1);
    const stamps = (await pool.query('SELECT revoked_by, revoked_at FROM intercompany_connections WHERE id = $1', [view.id])).rows[0];
    expect(stamps).toEqual({ revoked_by: null, revoked_at: null });
  });

  it.each([
    ['itself', () => ({ partnerCompanyId: co.A })],
    ['a non-UUID', () => ({ partnerCompanyId: 'nope' })],
    ['a number', () => ({ partnerCompanyId: 5 })],
    ['an unknown key', () => ({ partnerCompanyId: co.B, kind: 'external' })],
    ['no body', () => null],
  ])('%s is a 400, not a 500', async (_n, body) => {
    expect((await api.create(U.ab, co.A, body())).state.statusCode).toBe(400);
  });

  it('lists the group companies it could connect to, with the existing status; a company that left is not offered', async () => {
    const before = dataOf<{ items: Array<{ companyId: string; connectionStatus: string | null }> }>(await api.candidates(U.ab, co.A));
    expect(before.items.map((i) => [i.companyId, i.connectionStatus])).toEqual([[co.B, null]]);
    await api.create(U.ab, co.A, { partnerCompanyId: co.B });
    const after = dataOf<{ items: Array<{ connectionStatus: string | null }> }>(await api.candidates(U.ab, co.A));
    expect(after.items[0]!.connectionStatus).toBe('active');
    // ua has no role in B, and avb is only a VIEWER of B: B is not a candidate for either.
    expect(dataOf<{ items: unknown[] }>(await api.candidates(U.a, co.A)).items).toEqual([]);
    expect(dataOf<{ items: unknown[] }>(await api.candidates(U.avb, co.A)).items).toEqual([]);
    expect(dataOf<{ items: unknown[] }>(await api.candidates(U.mab, co.A)).items).toHaveLength(1);
  });

  it('group-candidates: a partner that has left the group is not offered; neither is the session company having left', async () => {
    await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    expect(dataOf<{ items: unknown[] }>(await api.candidates(U.ab, co.A)).items).toEqual([]);
    await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.A]);
    expect(dataOf<{ items: unknown[] }>(await api.candidates(U.ab, co.A)).items).toEqual([]);
  });
});

describe('the connection list names only the session company and carries the pair settings', () => {
  it('shows pair settings to both parties, and canEditSettings only to a user who can write in both', async () => {
    await plantConnection(pool, co.A, co.B);
    const asBoth = dataOf<{ items: Array<{ settings: { settlementMode: string }; canEditSettings: boolean }> }>(await api.list(U.ab, co.A)).items[0]!;
    expect(asBoth).toMatchObject({ settings: { settlementMode: 'cash' }, canEditSettings: true });
    const asA = dataOf<{ items: Array<{ canEditSettings: boolean }> }>(await api.list(U.a, co.A)).items[0]!;
    expect(asA.canEditSettings).toBe(false);
  });
});
