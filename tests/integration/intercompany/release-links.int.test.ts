/**
 * Intercompany (1002): a revoked connection releases its sides' customer and supplier links (so the per-company unique
 * indexes do not hold them on a dead connection), by a registered definer; and 1002 itself applies cleanly on a database
 * that already holds rows, twice, backfilling what 1000 left behind.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { dataOf } from '../r035-pr2.helpers';
import {
  acct, api, asAppUser, asOwner, cleanup, co, dim, outcome, party, plantConnection, plantSide, R, setup, U, wipeConnections, withoutTrigger,
} from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';
const MIGRATION = readFileSync(resolve(__dirname, '../../../scripts/migrations/sql/1002_intercompany_round2.sql'), 'utf8');

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

const sideOf = async (company: string, connection = id) =>
  (await pool.query('SELECT * FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [connection, company])).rows[0];
const status = async (c = id) => (await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [c])).rows[0].status as string;

/** Both companies' sides, each linking its own customer and supplier and carrying settings that are NOT links. */
async function linkedSides() {
  await plantSide(pool, id, co.A, co.B, {
    customer_id: party.aCustomer, supplier_id: party.aSupplier, loan_account_id: acct.aLoan, default_expense_account_id: acct.aExpense,
    default_cc1_id: dim.aCc1, default_bu_id: dim.aBu, auto_accept: true,
  }, U.a);
  await plantSide(pool, id, co.B, co.A, { customer_id: party.bCustomer, supplier_id: party.bSupplier }, U.b);
}

describe('a revoked connection releases the links', () => {
  it('revoked by either party (route): both sides lose customer and supplier, keep everything else, and the connection is revoked', async () => {
    for (const [by, company] of [[U.a, co.A], [U.b, co.B]] as const) {
      await wipeConnections(pool);
      id = await plantConnection(pool, co.A, co.B);
      await linkedSides();
      expect((await api.revoke(by, company, id)).state.statusCode).toBe(200);
      expect(await status()).toBe('revoked');
      expect(await sideOf(co.A)).toMatchObject({
        customer_id: null, supplier_id: null, loan_account_id: acct.aLoan, default_expense_account_id: acct.aExpense,
        default_cc1_id: dim.aCc1, default_bu_id: dim.aBu, auto_accept: true,
      });
      expect(await sideOf(co.B)).toMatchObject({ customer_id: null, supplier_id: null });
    }
  });

  it("the partner's side is released too although the revoking session cannot see or write it (definer)", async () => {
    await linkedSides();
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect((await q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id])).rowCount).toBe(1);
    }, true);
    expect((await sideOf(co.B)).customer_id).toBeNull();
    expect((await sideOf(co.B)).supplier_id).toBeNull();
  });

  it('a company leaving the group (system revocation) releases them as well', async () => {
    await linkedSides();
    await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    expect(await status()).toBe('revoked');
    expect(await sideOf(co.A)).toMatchObject({ customer_id: null, supplier_id: null, loan_account_id: acct.aLoan });
    expect(await sideOf(co.B)).toMatchObject({ customer_id: null, supplier_id: null });
  });

  it('a deleted group (is_active = false) releases them as well', async () => {
    await linkedSides();
    await pool.query('UPDATE company_groups SET is_active = false WHERE id = $1', [co.G]);
    try {
      expect(await status()).toBe('revoked');
      expect((await sideOf(co.A)).customer_id).toBeNull();
    } finally {
      await pool.query('UPDATE company_groups SET is_active = true WHERE id = $1', [co.G]);
    }
  });

  it('then the same customer and supplier can be linked on another connection of the company (the unique index no longer holds them)', async () => {
    await linkedSides();
    const g2 = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC release group')", [g2]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [g2, co.A, co.C]);
    try {
      const second = await plantConnection(pool, co.A, co.C, U.ac);
      await asAppUser(pool, U.ac, co.A, async (q) => {
        expect(await outcome(q, 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, customer_id) VALUES ($1, $2, $3, $4)',
          [second, co.A, co.C, party.aCustomer])).toMatch(/^23505: duplicate key value violates unique constraint "intercompany_sides_customer_uq"/);
      });
      await api.revoke(U.a, co.A, id);
      const res = await api.edit(U.ac, co.A, second, { customerId: party.aCustomer, supplierId: party.aSupplier });
      expect(res.state.statusCode).toBe(200);
      expect(dataOf<{ side: { customerId: string } }>(res).side.customerId).toBe(party.aCustomer);
    } finally {
      await pool.query('DELETE FROM intercompany_connection_sides');
      await pool.query('DELETE FROM intercompany_connections');
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [g2]);
    }
  });

  it('re-activating restores nothing: the links stay released, the other settings stay, the checklist shows them undone', async () => {
    await linkedSides();
    await api.revoke(U.a, co.A, id);
    const again = await api.create(U.ab, co.A, { partnerCompanyId: co.B });
    expect(again.state.statusCode).toBe(201);
    const view = dataOf<{ side: { customerId: string | null; loanAccountId: string }; checklist: { items: Array<{ key: string; done: boolean }> } }>(again);
    expect(view.side).toMatchObject({ customerId: null, loanAccountId: acct.aLoan });
    expect(view.checklist.items.find((i) => i.key === 'customer')?.done).toBe(false);
  });

  it('a connection that is not revoked keeps its links (other status changes and unrelated updates do not release)', async () => {
    await linkedSides();
    await api.settings(U.ab, co.A, id, { settlementMode: 'loan' });
    await api.edit(U.a, co.A, id, { autoAccept: false });
    expect(await sideOf(co.A)).toMatchObject({ customer_id: party.aCustomer, supplier_id: party.aSupplier });
    expect(await sideOf(co.B)).toMatchObject({ customer_id: party.bCustomer });
  });

  it('is a registered definer with a pinned path, owned by migration_admin, executable by no app role', async () => {
    const f = (await pool.query(
      `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              (SELECT count(*) FROM app_definer_reviews r WHERE r.signature = p.oid::regprocedure::text AND r.body_md5 = app_definer_hash(p.oid)) AS reviewed,
              (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgname = 'trg_intercompany_release_links') AS trigger_def
         FROM pg_proc p WHERE p.proname = 'intercompany_release_links'`)).rows[0];
    expect(f).toMatchObject({ prosecdef: true, owner: 'migration_admin', app_user: false, public_exec: false, reviewed: '1' });
    expect(f.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    expect(f.trigger_def).toMatch(/AFTER UPDATE OF status ON (public\.)?intercompany_connections FOR EACH ROW WHEN .*revoked/);
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
  });
});

describe('1002 on a database that already holds rows', () => {
  it('the backfill revokes a group connection whose group has gone and releases the links of revoked connections', async () => {
    // a stale group connection: the group is deactivated with the revoking trigger off, as 1000 alone would have left it
    const live = id;
    await plantSide(pool, live, co.A, co.B, { customer_id: party.aCustomer }, U.a);
    await withoutTrigger(pool, 'company_groups', 'trg_intercompany_group_deactivated', (q) => q.query('UPDATE company_groups SET is_active = false WHERE id = $1', [co.G]));
    try {
      expect(await status(live)).toBe('active');
      const backfill = MIGRATION.slice(MIGRATION.indexOf('-- ── 9. Backfill'));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(backfill);
        // the system flag does not outlive the backfill
        expect((await client.query("SELECT current_setting('app.intercompany_system_revoke', true) AS v")).rows[0].v).toBe('');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const row = (await pool.query('SELECT status, revoked_by FROM intercompany_connections WHERE id = $1', [live])).rows[0];
      expect(row).toEqual({ status: 'revoked', revoked_by: 'system:group-membership' });
      expect((await sideOf(co.A, live)).customer_id).toBeNull();
    } finally {
      await pool.query('UPDATE company_groups SET is_active = true WHERE id = $1', [co.G]);
    }
  });

  it('the backfill releases the links a connection revoked before 1002 still holds, and leaves a live connection alone', async () => {
    await linkedSides();
    await asOwner(pool, U.ab, co.A, async (q) => {
      await q.query('ALTER TABLE intercompany_connections DISABLE TRIGGER trg_intercompany_release_links');
      await q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]);
      await q.query('ALTER TABLE intercompany_connections ENABLE ALWAYS TRIGGER trg_intercompany_release_links');
    }, true);
    expect((await sideOf(co.A)).customer_id).toBe(party.aCustomer);
    // a LIVE connection of company A (A-C, in a second group) that links a customer of its own
    const g2 = crypto.randomUUID();
    const other = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC backfill group')", [g2]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [g2, co.A, co.C]);
    await pool.query("INSERT INTO customers(id, company_id, name) VALUES ($1, $2, 'IC live customer')", [other, co.A]);
    const live = await plantConnection(pool, co.A, co.C, U.ac);
    await plantSide(pool, live, co.A, co.C, { customer_id: other }, U.ac);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(MIGRATION.slice(MIGRATION.indexOf('-- ── 9. Backfill')));
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await sideOf(co.A)).toMatchObject({ customer_id: null, supplier_id: null, loan_account_id: acct.aLoan });
    expect(await sideOf(co.B)).toMatchObject({ customer_id: null, supplier_id: null });
    expect(await sideOf(co.A, live)).toMatchObject({ customer_id: other, supplier_id: null });   // a live connection keeps its link
    // the guard that was switched off for the backfill is back on
    expect((await pool.query("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_intercompany_sides_guard'")).rows[0].tgenabled).toBe('A');
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET auto_accept = false WHERE connection_id = $1', [id])).toBe(R.sideRevoked);
    });
    await pool.query('DELETE FROM intercompany_connection_sides WHERE connection_id = $1', [live]);
    await pool.query('DELETE FROM intercompany_connections WHERE id = $1', [live]);
    await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [g2]);
    await pool.query('DELETE FROM company_groups WHERE id = $1', [g2]);
    await pool.query('DELETE FROM customers WHERE id = $1', [other]);
  });

  it('the whole migration can be applied again on a database holding rows, and changes nothing observable', async () => {
    await linkedSides();
    const before = (await pool.query('SELECT count(*)::int AS n FROM app_definer_reviews')).rows[0].n;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(MIGRATION);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM app_definer_reviews')).rows[0].n).toBe(before);
    expect(await status()).toBe('active');
    expect(await sideOf(co.A)).toMatchObject({ customer_id: party.aCustomer, supplier_id: party.aSupplier });
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_intercompany_release_links' AND tgenabled = 'A'")).rows[0].n).toBe(1);
  });
});
