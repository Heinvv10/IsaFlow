/**
 * Intercompany P1 (999p): the message, link and key tables are tables only in P1 (no code writes them yet), but
 * the rules P2-P6 stand on are in the database now: one message per source document, a message only on an
 * active connection between its two companies, the sender only inserts and the receiver only moves a pending
 * message on, links name the connection's pair in order, and a key is one company's own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, count, outcome, pairOf, plantConnection, setup, U, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, 'group', co.A, co.B);
});

const MSG = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
             VALUES ($1, $2, $3, $4, 'customer_invoice', $5, '{"number":"INV-1"}') RETURNING id`;
const DOC = crypto.randomUUID();

async function send(from: string, to: string, user: string, kind = 'invoice', doc = DOC): Promise<string> {
  return asAppUser(pool, user, from, async (q) => (await q.query(MSG, [id, from, to, kind, doc])).rows[0].id as string, true);
}

describe('messages', () => {
  it('one message per (from company, source type, source id, kind); another kind or document is fine', async () => {
    await send(co.A, co.B, U.a);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, MSG, [id, co.A, co.B, 'invoice', DOC])).toMatch(/^23505.*intercompany_messages_once/);
      expect(await outcome(q, MSG, [id, co.A, co.B, 'credit_note', DOC])).toBe('ok');
      expect(await outcome(q, MSG, [id, co.A, co.B, 'invoice', crypto.randomUUID()])).toBe('ok');
    });
  });

  it('the sender writes only as itself, between the two companies of an ACTIVE connection', async () => {
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, MSG, [id, co.A, co.B, 'invoice', DOC])).toMatch(/^42501/); // as A, from B's session
    });
    await asAppUser(pool, U.ac, co.A, async (q) => {
      expect(await outcome(q, MSG, [id, co.A, co.C, 'invoice', DOC])).toMatch(/^23514: a message goes between/);
      expect(await outcome(q, MSG, [id, co.A, co.A, 'invoice', DOC])).toMatch(/^23514/);
    });
    await asAppUser(pool, U.a, co.A, async (q) => {
      await q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]);
      expect(await outcome(q, MSG, [id, co.A, co.B, 'invoice', crypto.randomUUID()])).toMatch(/^23514: a message is sent only on an active connection/);
    });
  });

  it('a sender cannot choose the status or the handling: they are reset on insert', async () => {
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload, status)
        VALUES ($1, $2, $3, 'invoice', 'customer_invoice', gen_random_uuid(), '{}', 'accepted')`, [id, co.A, co.B])).toMatch(/^42501/); // no INSERT grant on status
    });
  });

  it('the receiver (not the sender) moves a pending message on; a handled message is final', async () => {
    const msg = await send(co.A, co.B, U.a);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect((await q.query("UPDATE intercompany_messages SET status = 'dismissed' WHERE id = $1", [msg])).rowCount).toBe(0);
    });
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_messages SET status = 'rejected' WHERE id = $1", [msg])).toMatch(/^23514.*reject_reason/); // a reason is required
      expect(await outcome(q, "UPDATE intercompany_messages SET status = 'rejected', reason = 'wrong amount' WHERE id = $1", [msg])).toBe('ok');
      expect(await outcome(q, "UPDATE intercompany_messages SET status = 'accepted' WHERE id = $1", [msg])).toMatch(/^23514: a handled message is final/);
    }, true);
    const row = (await pool.query('SELECT status, handled_by, reason FROM intercompany_messages WHERE id = $1', [msg])).rows[0];
    expect(row).toEqual({ status: 'rejected', handled_by: U.b, reason: 'wrong amount' });
  });

  it("the payload, parties and source cannot be rewritten by anyone, the receiver included", async () => {
    const msg = await send(co.A, co.B, U.a);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_messages SET payload = '{}' WHERE id = $1", [msg])).toMatch(/^42501/);
      expect(await outcome(q, 'UPDATE intercompany_messages SET to_company_id = $2 WHERE id = $1', [msg, co.A])).toMatch(/^42501/);
    });
  });

  it('only the two parties read a message; a third company sees none', async () => {
    await send(co.A, co.B, U.a);
    expect(await asAppUser(pool, U.c, co.C, (q) => count(q, 'SELECT COUNT(*)::int AS n FROM intercompany_messages'))).toBe(0);
    expect(await asAppUser(pool, U.b, co.B, (q) => count(q, 'SELECT COUNT(*)::int AS n FROM intercompany_messages'))).toBe(1);
    expect(await asAppUser(pool, U.a, co.A, (q) => count(q, 'SELECT COUNT(*)::int AS n FROM intercompany_messages'))).toBe(1);
  });

  it('app_user can delete none of the five tables', async () => {
    const msg = await send(co.A, co.B, U.a);
    await asAppUser(pool, U.a, co.A, async (q) => {
      for (const t of ['intercompany_messages', 'intercompany_connections', 'intercompany_connection_sides', 'intercompany_document_links', 'company_connection_keys']) {
        expect(await outcome(q, `DELETE FROM ${t}`)).toMatch(/^42501/);
      }
    });
    expect(await count(pool, 'SELECT COUNT(*)::int AS n FROM intercompany_messages WHERE id = $1', [msg])).toBe(1);
  });
});

describe('document links', () => {
  const LINK = `INSERT INTO intercompany_document_links(connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin)
                VALUES ($1, $2, 'customer_invoice', $4, $3, 'supplier_invoice', $5, 'manual_pairing')`;

  it("a party links its connection's pair in order (low = A, high = B); a document pairs once", async () => {
    const [low, high] = pairOf(co.A, co.B);
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, LINK, [id, high, low, a, b])).toMatch(/^23514: a link names the connection's low company as A/);
      expect(await outcome(q, LINK, [id, low, high, a, b])).toBe('ok');
      expect(await outcome(q, LINK, [id, low, high, a, crypto.randomUUID()])).toMatch(/^23505.*intercompany_links_doc_a/);
      expect(await outcome(q, LINK, [id, low, high, crypto.randomUUID(), b])).toMatch(/^23505.*intercompany_links_doc_b/);
    });
  });

  it('C cannot link anything on the A-B connection, and cannot read its links', async () => {
    const [low, high] = pairOf(co.A, co.B);
    await asAppUser(pool, U.c, co.C, async (q) => {
      expect(await outcome(q, LINK, [id, low, high, crypto.randomUUID(), crypto.randomUUID()])).toMatch(/^(42501|23503)/);
      expect(await count(q, 'SELECT COUNT(*)::int AS n FROM intercompany_document_links')).toBe(0);
    });
  });

  it('no link on a revoked connection', async () => {
    const [low, high] = pairOf(co.A, co.B);
    await asAppUser(pool, U.a, co.A, async (q) => {
      await q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]);
      expect(await outcome(q, LINK, [id, low, high, crypto.randomUUID(), crypto.randomUUID()])).toMatch(/^23514: documents are linked only on an active connection/);
    });
  });
});

describe('connection keys', () => {
  const KEY = "INSERT INTO company_connection_keys(company_id, key_hash) VALUES ($1, $2)";
  const hash = (c: string) => c.repeat(64).slice(0, 64);

  it("a company stores its own key hash only: hex, 64 characters, unique, one per company", async () => {
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, KEY, [co.A, hash('a')])).toBe('ok');
      expect(await outcome(q, KEY, [co.A, hash('b')])).toMatch(/^23505/); // one key per company
      expect(await outcome(q, KEY, [co.B, hash('c')])).toMatch(/^42501/); // not another company's
    }, true);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, KEY, [co.B, hash('a')])).toMatch(/^23505/); // the hash is globally unique
      expect(await outcome(q, KEY, [co.B, 'not-a-hash'])).toMatch(/^23514/);
    });
  });

  it("another company reads no key row", async () => {
    await pool.query(KEY, [co.A, hash('d')]);
    expect(await asAppUser(pool, U.b, co.B, (q) => count(q, 'SELECT COUNT(*)::int AS n FROM company_connection_keys'))).toBe(0);
    expect(await asAppUser(pool, U.a, co.A, (q) => count(q, 'SELECT COUNT(*)::int AS n FROM company_connection_keys'))).toBe(1);
  });
});
