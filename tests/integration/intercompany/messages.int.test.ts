/**
 * Intercompany P1 (999p): the message table is a table only in P1 (no code writes it yet), but the rules P2-P6 stand
 * on are in the database now: one message per source document, a message only on an active connection between its two
 * companies (a group one only while both stay in one group), the sender only inserts and the receiver only moves a
 * pending message on, handled messages are final (a dismissal can be restored), the handling is stamped server-side.
 * Trigger-level rules are tested as the table owner so the trigger's own refusal is what is asserted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, asOwner, cleanup, co, count, outcome, plantConnection, plantMessage, R, setup, U, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

const MSG = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
             VALUES ($1, $2, $3, $4, 'customer_invoice', $5, '{"number":"INV-1"}') RETURNING id`;
const DOC = crypto.randomUUID();
const msgRow = async (m: string) => (await pool.query('SELECT * FROM intercompany_messages WHERE id = $1', [m])).rows[0];
const handle = (user: string, company: string, m: string, set: string) =>
  asAppUser(pool, user, company, async (q) => outcome(q, `UPDATE intercompany_messages SET ${set} WHERE id = $1`, [m]), true);

describe('inserting', () => {
  it('one message per (from company, source type, source id, kind); another kind or document is fine', async () => {
    await plantMessage(pool, id, co.A, co.B, { doc: DOC });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, MSG, [id, co.A, co.B, 'invoice', DOC]))
        .toBe('23505: duplicate key value violates unique constraint "intercompany_messages_once"');
      expect(await outcome(q, MSG, [id, co.A, co.B, 'credit_note', DOC])).toBe('ok');
      expect(await outcome(q, MSG, [id, co.A, co.B, 'invoice', crypto.randomUUID()])).toBe('ok');
    });
  });

  it('the sender writes only as itself, between the two companies of an ACTIVE connection', async () => {
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, MSG, [id, co.A, co.B, 'invoice', DOC])).toBe('42501: new row violates row-level security policy for table "intercompany_messages"');
    });
    await asAppUser(pool, U.ac, co.A, async (q) => {
      expect(await outcome(q, MSG, [id, co.A, co.C, 'invoice', DOC])).toBe(R.msgParties);
      expect(await outcome(q, MSG, [id, co.A, co.A, 'invoice', DOC])).toBe(R.msgParties);
    });
    await asAppUser(pool, U.a, co.A, async (q) => {
      await q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]);
      expect(await outcome(q, MSG, [id, co.A, co.B, 'invoice', crypto.randomUUID()])).toBe(R.msgNotActive);
    });
  });

  it('a payload over 256 KiB is refused, one under it is accepted', async () => {
    await asAppUser(pool, U.a, co.A, async (q) => {
      const big = JSON.stringify({ blob: 'x'.repeat(262144) });
      const ok = JSON.stringify({ blob: 'x'.repeat(1000) });
      const insert = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
                      VALUES ($1, $2, $3, 'invoice', 'customer_invoice', gen_random_uuid(), $4::jsonb)`;
      expect(await outcome(q, insert, [id, co.A, co.B, big]))
        .toBe('23514: new row for relation "intercompany_messages" violates check constraint "intercompany_messages_payload_size"');
      expect(await outcome(q, insert, [id, co.A, co.B, ok])).toBe('ok');
    });
  });

  it('a sender cannot choose the status or the handling through the grant, and the trigger resets them when the grant is there (owner)', async () => {
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload, status)
        VALUES ($1, $2, $3, 'invoice', 'customer_invoice', gen_random_uuid(), '{}', 'accepted')`, [id, co.A, co.B])).toBe('42501: permission denied for table intercompany_messages');
    });
    const doc = crypto.randomUUID();
    await asOwner(pool, U.a, co.A, async (q) => {
      await q.query(`INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload,
          status, target_doc_type, target_doc_id, reason, error, handled_by, handled_at, handled_via, created_at)
        VALUES ($1, $2, $3, 'invoice', 'customer_invoice', $4, '{}', 'accepted', 'supplier_invoice', gen_random_uuid(), 'r', 'e', 'someone', now(), 'auto', '2001-01-01')`,
      [id, co.A, co.B, doc]);
    }, true);
    const r = (await pool.query('SELECT * FROM intercompany_messages WHERE source_doc_id = $1', [doc])).rows[0];
    expect(r).toMatchObject({ status: 'pending', target_doc_type: null, target_doc_id: null, reason: null, error: null, handled_by: null, handled_at: null, handled_via: null });
    expect(r.created_at.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('on a GROUP connection both companies must still be in one group (trigger disabled to reach the guard)', async () => {
    await pool.query('ALTER TABLE company_group_members DISABLE TRIGGER trg_intercompany_group_membership');
    try {
      await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
      await asAppUser(pool, U.a, co.A, async (q) => {
        expect(await outcome(q, MSG, [id, co.A, co.B, 'invoice', DOC])).toBe(R.msgOneGroup);
      });
    } finally {
      await pool.query('ALTER TABLE company_group_members ENABLE ALWAYS TRIGGER trg_intercompany_group_membership');
    }
  });
});

describe('handling', () => {
  it('the receiver (not the sender) moves a pending message on; the stamps are the session user and the clock', async () => {
    const m = await plantMessage(pool, id, co.A, co.B);
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect((await q.query("UPDATE intercompany_messages SET status = 'dismissed' WHERE id = $1", [m])).rowCount).toBe(0);
    });
    expect(await handle(U.b, co.B, m, "status = 'rejected'")).toBe('23514: new row for relation "intercompany_messages" violates check constraint "intercompany_messages_reject_reason"');
    expect(await handle(U.b, co.B, m, "status = 'rejected', reason = 'wrong amount', handled_by = 'x'")).toBe('42501: permission denied for table intercompany_messages');
    expect(await handle(U.b, co.B, m, "status = 'rejected', reason = 'wrong amount'")).toBe('ok');
    const r = await msgRow(m);
    expect(r).toMatchObject({ status: 'rejected', handled_by: U.b, reason: 'wrong amount', handled_via: 'user' });
    expect(r.handled_at).toBeInstanceOf(Date);
  });

  it("handled_via is 'auto' only when the session says so, and a made-up value is 'user'", async () => {
    const m1 = await plantMessage(pool, id, co.A, co.B);
    const m2 = await plantMessage(pool, id, co.A, co.B);
    await asAppUser(pool, U.b, co.B, async (q) => {
      await q.query("SELECT set_config('app.intercompany_handled_via', 'auto', true)");
      await q.query("UPDATE intercompany_messages SET status = 'accepted' WHERE id = $1", [m1]);
      await q.query("SELECT set_config('app.intercompany_handled_via', 'robot', true)");
      await q.query("UPDATE intercompany_messages SET status = 'accepted' WHERE id = $1", [m2]);
    }, true);
    expect((await msgRow(m1)).handled_via).toBe('auto');
    expect((await msgRow(m2)).handled_via).toBe('user');
  });

  it('accepted and rejected are final; a dismissal can only be restored to pending, which clears the handling', async () => {
    const m = await plantMessage(pool, id, co.A, co.B);
    expect(await handle(U.b, co.B, m, "status = 'dismissed'")).toBe('ok');
    expect(await handle(U.b, co.B, m, "status = 'accepted'")).toBe(R.msgDismissed);
    expect(await handle(U.b, co.B, m, "status = 'rejected', reason = 'r'")).toBe(R.msgDismissed);
    expect(await handle(U.b, co.B, m, "status = 'pending'")).toBe('ok');
    expect(await msgRow(m)).toMatchObject({ status: 'pending', handled_by: null, handled_at: null, handled_via: null });
    expect(await handle(U.b, co.B, m, "status = 'accepted'")).toBe('ok');
    expect(await handle(U.b, co.B, m, "status = 'pending'")).toBe(R.msgFinal);
    expect(await handle(U.b, co.B, m, "status = 'dismissed'")).toBe(R.msgFinal);
    const rej = await plantMessage(pool, id, co.A, co.B);
    await handle(U.b, co.B, rej, "status = 'rejected', reason = 'r'");
    expect(await handle(U.b, co.B, rej, "status = 'pending'")).toBe(R.msgFinal);
  });

  it('a failed message is not final: it can be retried', async () => {
    const m = await plantMessage(pool, id, co.A, co.B);
    expect(await handle(U.b, co.B, m, "status = 'failed', error = 'The invoice could not be created.'")).toBe('ok');
    expect(await handle(U.b, co.B, m, "status = 'accepted'")).toBe('ok');
  });

  it('a message is accepted only while the connection is active', async () => {
    const m = await plantMessage(pool, id, co.A, co.B);
    await asOwner(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    expect(await handle(U.b, co.B, m, "status = 'accepted'")).toBe(R.msgAcceptActive);
    expect(await handle(U.b, co.B, m, "status = 'dismissed'")).toBe('ok'); // a refusal or dismissal is still possible
  });

  it('the payload, parties and source cannot be rewritten by anyone (trigger, as owner)', async () => {
    const m = await plantMessage(pool, id, co.A, co.B);
    await asOwner(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_messages SET payload = '{}' WHERE id = $1", [m])).toBe(R.msgImmutable);
      expect(await outcome(q, 'UPDATE intercompany_messages SET to_company_id = from_company_id, from_company_id = to_company_id WHERE id = $1', [m])).toBe(R.msgImmutable);
      expect(await outcome(q, "UPDATE intercompany_messages SET kind = 'credit_note' WHERE id = $1", [m])).toBe(R.msgImmutable);
      expect(await outcome(q, "UPDATE intercompany_messages SET source_doc_type = 'x' WHERE id = $1", [m])).toBe(R.msgImmutable);
      expect(await outcome(q, 'UPDATE intercompany_messages SET source_doc_id = gen_random_uuid() WHERE id = $1', [m])).toBe(R.msgImmutable);
      expect(await outcome(q, "UPDATE intercompany_messages SET created_at = '2001-01-01' WHERE id = $1", [m])).toBe(R.msgImmutable);
    });
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_messages SET payload = '{}' WHERE id = $1", [m])).toBe('42501: permission denied for table intercompany_messages');
    });
  });
});

describe('visibility and deletion', () => {
  it('only the two parties read a message; a third company sees none', async () => {
    await plantMessage(pool, id, co.A, co.B);
    const n = (user: string, company: string) => asAppUser(pool, user, company, (q) => count(q, 'SELECT COUNT(*)::int AS n FROM intercompany_messages'));
    expect(await n(U.c, co.C)).toBe(0);
    expect(await n(U.b, co.B)).toBe(1);
    expect(await n(U.a, co.A)).toBe(1);
  });

  it('app_user can delete none of the five tables', async () => {
    const m = await plantMessage(pool, id, co.A, co.B);
    await asAppUser(pool, U.a, co.A, async (q) => {
      for (const t of ['intercompany_messages', 'intercompany_connections', 'intercompany_connection_sides', 'intercompany_document_links', 'company_connection_keys']) {
        expect(await outcome(q, `DELETE FROM ${t}`)).toBe(`42501: permission denied for table ${t}`);
      }
    });
    expect(await count(pool, 'SELECT COUNT(*)::int AS n FROM intercompany_messages WHERE id = $1', [m])).toBe(1);
  });
});
