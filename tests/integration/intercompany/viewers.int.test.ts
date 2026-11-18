/**
 * Intercompany (1000): a viewer reads and writes nothing. Every app_user write on connections, sides and keys needs a write
 * role in the company it acts as (messages and links have their own suites); the same statement by a writer succeeds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { api, asAppUser, cleanup, co, count, outcome, pairOf, party, plantConnection, plantExternal, plantKey, plantSide, R, setup, U, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

const status = async (c = id) => (await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [c])).rows[0].status as string;

describe('connections', () => {
  it('a viewer cannot revoke, in SQL (the guard) or through the route (403); a writer can', async () => {
    await asAppUser(pool, U.va, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id])).toBe(R.statusWriteRole);
    });
    expect((await api.revoke(U.va, co.A, id)).state.statusCode).toBe(403);
    // the owner of A who only VIEWS B, acting as B
    await asAppUser(pool, U.avb, co.B, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id])).toBe(R.statusWriteRole);
    });
    expect(await status()).toBe('active');
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id])).toBe('ok');
    }, true);
    expect(await status()).toBe('revoked');
  });

  it('a viewer cannot re-activate a revoked connection or accept an invitation', async () => {
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    await asAppUser(pool, U.va, co.A, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [id])).toBe(R.statusWriteRole);
    });
    // an external invitation (planted with the guard off: none can be created until P6) is accepted by the OTHER company's writer only
    const ext = await plantExternal(pool, co.A, co.C, 'pending', U.ac);
    const invitee = pairOf(co.A, co.C)[1];
    const inviteeViewer = invitee === co.C ? U.vc : U.va;
    await asAppUser(pool, inviteeViewer, invitee, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [ext])).toBe(R.statusWriteRole);
    });
    expect(await status(ext)).toBe('pending');
    await asAppUser(pool, U.ac, invitee, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [ext])).toBe('ok');
    });
  });

  it('a viewer cannot create a connection; the pair settings need a writer in both', async () => {
    const res = await api.create(U.va, co.A, { partnerCompanyId: co.B });
    expect(res.state.statusCode).toBe(403);
    expect((await api.settings(U.va, co.A, id, { settlementMode: 'loan' })).state.statusCode).toBe(403);
  });
});

describe('sides', () => {
  it('a viewer cannot insert or change a side (SQL and route); a writer can', async () => {
    await asAppUser(pool, U.va, co.A, async (q) => {
      expect(await outcome(q, 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id) VALUES ($1, $2, $3)', [id, co.A, co.B])).toBe(R.sideWriteRole);
    });
    expect((await api.edit(U.va, co.A, id, { customerId: party.aCustomer })).state.statusCode).toBe(403);
    await plantSide(pool, id, co.A, co.B);
    await asAppUser(pool, U.va, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET customer_id = $2 WHERE connection_id = $1', [id, party.aCustomer])).toBe(R.sideWriteRole);
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET customer_id = NULL WHERE connection_id = $1', [id])).toBe(R.sideWriteRole);
    });
    // an owner of A acting as B, who only views B
    await asAppUser(pool, U.avb, co.B, async (q) => {
      expect(await outcome(q, 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id) VALUES ($1, $2, $3)', [id, co.B, co.A])).toBe(R.sideWriteRole);
    });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET customer_id = $2 WHERE connection_id = $1', [id, party.aCustomer])).toBe('ok');
    });
  });

  it('a viewer cannot clear a link by an UPDATE to NULL either (only a foreign key action, one trigger level down, may)', async () => {
    await plantSide(pool, id, co.A, co.B, { customer_id: party.aCustomer });
    await asAppUser(pool, U.va, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_connection_sides SET customer_id = NULL WHERE connection_id = $1', [id])).toBe(R.sideWriteRole);
    });
  });
});

describe('keys', () => {
  it('a viewer cannot insert or rotate a key; a writer can', async () => {
    await asAppUser(pool, U.va, co.A, async (q) => {
      expect(await outcome(q, "INSERT INTO company_connection_keys(company_id, key_hash) VALUES ($1, repeat('a', 64))", [co.A])).toBe(R.keyWriteRole);
    });
    await plantKey(pool, co.A, 'b'.repeat(64));
    await asAppUser(pool, U.va, co.A, async (q) => {
      expect(await outcome(q, "UPDATE company_connection_keys SET key_hash = repeat('c', 64)")).toBe(R.keyWriteRole);
      expect(await count(q, 'SELECT COUNT(*)::int AS n FROM company_connection_keys')).toBe(1);   // reading is allowed
    });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, "UPDATE company_connection_keys SET key_hash = repeat('c', 64), rotated_at = now()")).toBe('ok');
    });
  });
});
