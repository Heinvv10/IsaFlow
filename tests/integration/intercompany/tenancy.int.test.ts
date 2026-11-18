/**
 * Intercompany P1 (999p): the two halves of every tenant policy, the connection-key table, and the side-options
 * route. Every policy is `<party column> = app.current_company_id() AND <party column> IN (auth.user_companies())`:
 * a session of a company is not enough, the user must also BELONG to it, so a user who is a member of nothing (or of
 * another company) with the company id forged to A's sees nothing of A's and changes nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { dataOf } from '../r035-pr2.helpers';
import {
  acct, api, asAppUser, cleanup, co, count, outcome, party, plantConnection, plantLink, plantMessage, plantSide, R, setup, U, wipeConnections,
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

const TABLES = ['intercompany_connections', 'intercompany_connection_sides', 'intercompany_messages', 'intercompany_document_links', 'company_connection_keys'] as const;
const hash = (c: string) => c.repeat(64).slice(0, 64);

async function seedEverything() {
  await plantSide(pool, id, co.A, co.B, { customer_id: party.aCustomer });
  await plantMessage(pool, id, co.A, co.B);
  await plantLink(pool, id);
  await pool.query('INSERT INTO company_connection_keys(company_id, key_hash) VALUES ($1, $2)', [co.A, hash('e')]);
}

describe('the user_companies() half of every policy', () => {
  it.each([['a member of nothing', () => U.x], ['a member of another company', () => U.c]])('%s, with the session company forged to A, reads none of the five tables', async (_n, user) => {
    await seedEverything();
    const seen = await asAppUser(pool, user(), co.A, async (q) => {
      const n: Record<string, number> = {};
      for (const t of TABLES) n[t] = await count(q, `SELECT COUNT(*)::int AS n FROM ${t}`);
      return n;
    });
    expect(seen).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
    // the control: a member sees them
    expect(await asAppUser(pool, U.a, co.A, (q) => count(q, 'SELECT COUNT(*)::int AS n FROM intercompany_connections'))).toBe(1);
  });

  it('and changes none of them: every UPDATE touches 0 rows, every INSERT is refused', async () => {
    await seedEverything();
    await asAppUser(pool, U.x, co.A, async (q) => {
      expect((await q.query("UPDATE intercompany_connections SET status = 'revoked'")).rowCount).toBe(0);
      expect((await q.query('UPDATE intercompany_connection_sides SET auto_accept = false')).rowCount).toBe(0);
      expect((await q.query("UPDATE intercompany_messages SET status = 'dismissed'")).rowCount).toBe(0);
      expect((await q.query("UPDATE intercompany_document_links SET status = 'unlinked'")).rowCount).toBe(0);
      expect((await q.query("UPDATE company_connection_keys SET key_hash = repeat('f', 64)")).rowCount).toBe(0);
      expect(await outcome(q, "INSERT INTO company_connection_keys(company_id, key_hash) VALUES ($1, $2)", [co.A, hash('9')]))
        .toBe('42501: new row violates row-level security policy for table "company_connection_keys"');
      expect(await outcome(q, `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id) VALUES ($1, $2, 'group', 'active', $1)`, [co.A, co.B]))
        .toBe(R.needsWriteBoth);
      expect(await outcome(q, 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id) VALUES ($1, $2, $3)', [id, co.A, co.B])).toBe(R.noNoConnection);
    });
    expect(await count(pool, "SELECT COUNT(*)::int AS n FROM intercompany_connections WHERE status = 'active'")).toBe(1);
  });

  it('every policy of the five tables names both halves (the WITH CHECK of the insert policies too)', async () => {
    const rows = (await pool.query(
      `SELECT c.relname, p.polname, p.polcmd, pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk,
              c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = ANY($1) AND p.polname NOT LIKE 'app\\_service\\_%' ORDER BY 1, 2`, [TABLES])).rows;
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) {
      const parts = [r.polcmd === 'a' ? null : r.qual, r.polcmd === 'r' || r.polcmd === 'd' ? null : r.chk].filter((x): x is string => x !== null);
      expect(parts.length, `${r.relname}.${r.polname}`).toBeGreaterThan(0);
      for (const part of parts) {
        expect(part, `${r.relname}.${r.polname}`).toContain('app.current_company_id()');
        expect(part, `${r.relname}.${r.polname}`).toContain('auth.user_companies()');
      }
      expect(r.rls && r.forced, r.relname).toBe(true);
    }
    expect(new Set(rows.map((r) => r.relname))).toEqual(new Set(TABLES));
  });
});

describe('company_connection_keys', () => {
  const KEY = 'INSERT INTO company_connection_keys(company_id, key_hash) VALUES ($1, $2)';

  it('a company inserts and rotates its OWN key (hash and rotated_at only), and nothing else', async () => {
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, KEY, [co.A, hash('a')])).toBe('ok');
      expect(await outcome(q, 'UPDATE company_connection_keys SET key_hash = $1, rotated_at = now() WHERE company_id = $2', [hash('b'), co.A])).toBe('ok');
      expect(await outcome(q, 'UPDATE company_connection_keys SET company_id = $1', [co.B])).toBe('42501: permission denied for table company_connection_keys');
    });
  });

  it('refuses another company\'s key, a second key for one company, a repeated hash and a malformed hash', async () => {
    await pool.query(KEY, [co.A, hash('a')]);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, KEY, [co.A, hash('c')])).toBe('42501: new row violates row-level security policy for table "company_connection_keys"');
      expect(await outcome(q, KEY, [co.B, hash('a')])).toBe('23505: duplicate key value violates unique constraint "company_connection_keys_key_hash_key"');
      expect(await outcome(q, KEY, [co.B, 'not-a-hash'])).toBe('23514: new row for relation "company_connection_keys" violates check constraint "company_connection_keys_key_hash_check"');
      expect(await outcome(q, KEY, [co.B, hash('A')])).toBe('23514: new row for relation "company_connection_keys" violates check constraint "company_connection_keys_key_hash_check"');
      expect(await outcome(q, KEY, [co.B, hash('1')])).toBe('ok');
    });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, KEY, [co.A, hash('d')])).toBe('23505: duplicate key value violates unique constraint "company_connection_keys_company_id_key"');
    });
  });

  it('another company reads no key row', async () => {
    await pool.query(KEY, [co.A, hash('d')]);
    expect(await asAppUser(pool, U.b, co.B, (q) => count(q, 'SELECT COUNT(*)::int AS n FROM company_connection_keys'))).toBe(0);
    expect(await asAppUser(pool, U.a, co.A, (q) => count(q, 'SELECT COUNT(*)::int AS n FROM company_connection_keys'))).toBe(1);
  });
});

describe('the side-options route offers the session company\'s own rows only', () => {
  it('A sees A\'s customers, suppliers and postable accounts; B sees B\'s; headers, inactive and deleted ones are not offered', async () => {
    await pool.query("UPDATE customers SET deleted_at = now() WHERE id = $1", [party.bCustomer]);
    try {
      const a = dataOf<{ customers: Array<{ id: string }>; suppliers: Array<{ id: string }>; accounts: Array<{ id: string }>; truncated: boolean }>(await api.options(U.a, co.A));
      expect(a.customers.map((c) => c.id)).toEqual(expect.arrayContaining([party.aCustomer]));
      expect(a.customers.map((c) => c.id)).not.toContain(party.bCustomer);
      expect(a.suppliers.map((c) => c.id)).toContain(party.aSupplier);
      expect(a.suppliers.map((c) => c.id)).not.toContain(party.bSupplier);
      const accounts = a.accounts.map((c) => c.id);
      expect(accounts).toEqual(expect.arrayContaining([acct.aLoan, acct.aExpense, acct.aChild]));
      expect(accounts).not.toContain(acct.aHeader);
      expect(accounts).not.toContain(acct.aInactive);
      expect(accounts).not.toContain(acct.bLoan);
      expect(a.truncated).toBe(false);
      const b = dataOf<{ customers: Array<{ id: string }>; suppliers: Array<{ id: string }>; accounts: Array<{ id: string }> }>(await api.options(U.b, co.B));
      expect(b.customers.map((c) => c.id)).not.toContain(party.bCustomer); // soft-deleted
      expect(b.suppliers.map((c) => c.id)).toEqual(expect.arrayContaining([party.bSupplier]));
      expect(b.suppliers.map((c) => c.id)).not.toContain(party.aSupplier);
      expect(b.accounts.map((c) => c.id)).toEqual(expect.arrayContaining([acct.bLoan]));
      expect(b.accounts.map((c) => c.id)).not.toContain(acct.aLoan);
    } finally {
      await pool.query('UPDATE customers SET deleted_at = NULL WHERE id = $1', [party.bCustomer]);
    }
  });

  it('a company the user is not a member of is refused by the session', async () => {
    const forged = await api.options(U.c, co.A);
    expect(forged.state.statusCode).toBeGreaterThanOrEqual(400);
  });
});
