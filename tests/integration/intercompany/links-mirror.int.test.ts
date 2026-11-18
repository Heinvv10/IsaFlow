/**
 * Intercompany (1000) mirror links: made by the receiver of an accepted message, joining exactly that message's two documents,
 * active at once. Trigger-level rules are tested as the table owner so the trigger's own refusal is what is asserted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import {
  asAppUser, asOwner, cleanup, co, outcome, plantConnection, plantMessage, R, setup, U, wipeConnections,
} from './intercompany.helpers';
import { LINK, acceptedMessage, high, linkRow, low, mirrorArgs, pairing } from './links.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

describe('a mirror link', () => {
  it('is made by the receiver of an accepted message, joins its documents, and is active at once (either direction)', async () => {
    for (const [from, to, user] of [[co.A, co.B, U.b], [co.B, co.A, U.a]] as const) {
      await wipeConnections(pool);
      id = await plantConnection(pool, co.A, co.B);
      const { m, src, tgt } = await acceptedMessage(pool, id, from, to);
      const link = await asAppUser(pool, user, to, async (q) => (await q.query(LINK, mirrorArgs(id, from, m, src, tgt))).rows[0].id as string, true);
      expect(await linkRow(pool, link)).toMatchObject({ status: 'active', origin: 'mirror', message_id: m, confirmed_by_a: user, confirmed_by_b: user, created_by: user });
      expect((await linkRow(pool, link)).confirmed_at).toBeInstanceOf(Date);
    }
  });

  it('needs its message; the message must be on this connection, accepted, and made by this receiver', async () => {
    const { m, src, tgt } = await acceptedMessage(pool, id, co.A, co.B);
    const args = mirrorArgs(id, co.A, m, src, tgt);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, [args[0], null, ...args.slice(2)])).toBe(R.mirrorNeedsMessage);
      expect(await outcome(q, LINK, [args[0], crypto.randomUUID(), ...args.slice(2)])).toBe(R.mirrorNoMessage);
    });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, LINK, args)).toBe(R.mirrorReceiver); // the SENDER cannot make it
    });
    const pending = await plantMessage(pool, id, co.A, co.B);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, mirrorArgs(id, co.A, pending, src, tgt))).toBe(R.mirrorAccepted);
    });
    // a message of ANOTHER connection is not found on this one
    const g2 = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC link group')", [g2]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [g2, co.A, co.C]);
    try {
      const other = await plantConnection(pool, co.A, co.C, U.ac);
      const foreign = await plantMessage(pool, other, co.A, co.C, { user: U.ac });
      await asAppUser(pool, U.b, co.B, async (q) => {
        expect(await outcome(q, LINK, mirrorArgs(id, co.A, foreign, src, tgt))).toBe(R.mirrorNoMessage);
      });
    } finally {
      await pool.query('DELETE FROM intercompany_messages');
      await pool.query('DELETE FROM intercompany_connections');
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [g2]);
    }
  });

  it('joins exactly the message\'s source and target documents and types, on the right sides', async () => {
    const { m, src, tgt } = await acceptedMessage(pool, id, co.A, co.B);
    const good = mirrorArgs(id, co.A, m, src, tgt);
    const other = crypto.randomUUID();
    const bad = (i: number, v: string) => good.map((x, k) => (k === i ? v : x));
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, bad(4, other))).toBe(R.mirrorDocs);
      expect(await outcome(q, LINK, bad(7, other))).toBe(R.mirrorDocs);
      expect(await outcome(q, LINK, bad(3, 'credit_note'))).toBe(R.mirrorDocs);
      expect(await outcome(q, LINK, bad(6, 'credit_note'))).toBe(R.mirrorDocs);
      // source and target swapped between the sides
      const swapped = [...good]; swapped[4] = good[7]; swapped[7] = good[4];
      expect(await outcome(q, LINK, swapped)).toBe(R.mirrorDocs);
      expect(await outcome(q, LINK, good)).toBe('ok');
    });
  });

  it('a document links once while the link is live; after an unlink it can be linked again', async () => {
    const { m, src, tgt } = await acceptedMessage(pool, id, co.A, co.B);
    const args = mirrorArgs(id, co.A, m, src, tgt);
    const first = await asAppUser(pool, U.b, co.B, async (q) => (await q.query(LINK, args)).rows[0].id as string, true);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, args)).toBe('23505: duplicate key value violates unique constraint "intercompany_links_doc_a_active"');
    });
    // a second message that targets the SAME receiver document, with a new source document: only the receiver's side clashes
    const again = await acceptedMessage(pool, id, co.A, co.B, { tgt });
    const receiverSide = co.B === low() ? 'a' : 'b';
    // a third message (another kind) from the SAME source document to a new receiver document: only the sender's side clashes
    const third = await acceptedMessage(pool, id, co.A, co.B, { src, kind: 'credit_note' });
    const senderSide = receiverSide === 'a' ? 'b' : 'a';
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, mirrorArgs(id, co.A, again.m, again.src, tgt))).toBe(`23505: duplicate key value violates unique constraint "intercompany_links_doc_${receiverSide}_active"`);
      expect(await outcome(q, LINK, mirrorArgs(id, co.A, third.m, src, third.tgt))).toBe(`23505: duplicate key value violates unique constraint "intercompany_links_doc_${senderSide}_active"`);
    });
    await asAppUser(pool, U.b, co.B, (q) => q.query("UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [first]), true);
    await asAppUser(pool, U.b, co.B, async (q) => { expect(await outcome(q, LINK, args)).toBe('ok'); });
  });

  it('is refused on a revoked connection, with the pair out of order, or from a session of neither company', async () => {
    const { m, src, tgt } = await acceptedMessage(pool, id, co.A, co.B);
    const args = mirrorArgs(id, co.A, m, src, tgt);
    await asAppUser(pool, U.b, co.B, async (q) => {
      const swapped = [...args]; swapped[2] = args[5]; swapped[5] = args[2];
      expect(await outcome(q, LINK, swapped)).toBe(R.linkOrder);
    });
    await asAppUser(pool, U.c, co.C, async (q) => {
      expect(await outcome(q, LINK, args)).toBe(R.noNoConnection);
    });
    await asOwner(pool, U.ab, co.C, async (q) => {
      expect(await outcome(q, LINK, args)).toBe(R.linkParty);
    });
    await asOwner(pool, null, co.B, async (q) => {
      expect(await outcome(q, LINK, args)).toBe(R.linkUser);
    });
    await asOwner(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, args)).toBe(R.linkNotActive);
    });
  });

  it('cannot be inserted with its status or confirmations chosen by the client (grant), and the document types are a closed list', async () => {
    const { m, src, tgt } = await acceptedMessage(pool, id, co.A, co.B);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, `INSERT INTO intercompany_document_links(connection_id, message_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin, status)
        VALUES ($1, $2, $3, 'customer_invoice', $4, $5, 'supplier_invoice', $6, 'mirror', 'active')`, [id, m, low(), src, high(), tgt])).toBe('42501: permission denied for table intercompany_document_links');
    });
    const defs = (await pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'intercompany_document_links'::regclass AND contype = 'c' AND conname LIKE '%doc_%_type_check' ORDER BY conname`)).rows;
    expect(defs.map((d) => d.conname)).toEqual(['intercompany_document_links_doc_a_type_check', 'intercompany_document_links_doc_b_type_check']);
    for (const d of defs) expect(d.def.match(/'([a-z_]+)'/g)).toEqual(["'customer_invoice'", "'supplier_invoice'", "'credit_note'"]);
  });
});
