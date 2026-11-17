/**
 * Intercompany P1 (999p): document links, the authoritative pair record. A MIRROR link is made by the receiver of an
 * accepted message and joins exactly that message's two documents; a MANUAL pairing starts pending, names a document
 * that exists in the inserter's own company, and goes active only when the other party confirms (a user with a write
 * role in both companies of a group may confirm both). Either party may unlink. Trigger-level rules are tested as the
 * table owner so the trigger's own refusal is what is asserted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import {
  asAppUser, asOwner, cleanup, co, count, outcome, pairOf, plantConnection, plantDocument, plantMessage, R, setup, U, wipeConnections,
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

const low = () => pairOf(co.A, co.B)[0];
const high = () => pairOf(co.A, co.B)[1];
const LINK = `INSERT INTO intercompany_document_links(connection_id, message_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`;
const linkRow = async (l: string) => (await pool.query('SELECT * FROM intercompany_document_links WHERE id = $1', [l])).rows[0];

/** An accepted message from `from` to `to`, with its source (sender's) and target (receiver's) documents. */
async function acceptedMessage(from: string, to: string, over: { src?: string; tgt?: string } = {}) {
  const src = over.src ?? (await plantDocument(pool, 'customer_invoice', from));
  const tgt = over.tgt ?? (await plantDocument(pool, 'supplier_invoice', to));
  const m = await plantMessage(pool, id, from, to, { doc: src, user: from === co.A ? U.a : U.b });
  await asAppUser(pool, to === co.A ? U.a : U.b, to, (q) => q.query(
    "UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'supplier_invoice', target_doc_id = $2 WHERE id = $1", [m, tgt]), true);
  return { m, src, tgt };
}

/** The link's columns for a mirror of a message from `from` (source customer_invoice) to the other (target supplier_invoice). */
function mirrorArgs(from: string, m: string, src: string, tgt: string) {
  return from === low()
    ? [id, m, low(), 'customer_invoice', src, high(), 'supplier_invoice', tgt, 'mirror']
    : [id, m, low(), 'supplier_invoice', tgt, high(), 'customer_invoice', src, 'mirror'];
}

describe('a mirror link', () => {
  it('is made by the receiver of an accepted message, joins its documents, and is active at once (either direction)', async () => {
    for (const [from, to, user] of [[co.A, co.B, U.b], [co.B, co.A, U.a]] as const) {
      await wipeConnections(pool);
      id = await plantConnection(pool, co.A, co.B);
      const { m, src, tgt } = await acceptedMessage(from, to);
      const link = await asAppUser(pool, user, to, async (q) => (await q.query(LINK, mirrorArgs(from, m, src, tgt))).rows[0].id as string, true);
      expect(await linkRow(link)).toMatchObject({ status: 'active', origin: 'mirror', message_id: m, confirmed_by_a: user, confirmed_by_b: user, created_by: user });
      expect((await linkRow(link)).confirmed_at).toBeInstanceOf(Date);
    }
  });

  it('needs its message; the message must be on this connection, accepted, and made by this receiver', async () => {
    const { m, src, tgt } = await acceptedMessage(co.A, co.B);
    const args = mirrorArgs(co.A, m, src, tgt);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, [args[0], null, ...args.slice(2)])).toBe(R.mirrorNeedsMessage);
      expect(await outcome(q, LINK, [args[0], crypto.randomUUID(), ...args.slice(2)])).toBe(R.mirrorNoMessage);
    });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, LINK, args)).toBe(R.mirrorReceiver); // the SENDER cannot make it
    });
    const pending = await plantMessage(pool, id, co.A, co.B);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, mirrorArgs(co.A, pending, src, tgt))).toBe(R.mirrorAccepted);
    });
    // a message of ANOTHER connection is not found on this one
    const g2 = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC link group')", [g2]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [g2, co.A, co.C]);
    try {
      const other = await plantConnection(pool, co.A, co.C, U.ac);
      const foreign = await plantMessage(pool, other, co.A, co.C, { user: U.ac });
      await asAppUser(pool, U.b, co.B, async (q) => {
        expect(await outcome(q, LINK, mirrorArgs(co.A, foreign, src, tgt))).toBe(R.mirrorNoMessage);
      });
    } finally {
      await pool.query('DELETE FROM intercompany_messages');
      await pool.query('DELETE FROM intercompany_connections');
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [g2]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [g2]);
    }
  });

  it('joins exactly the message\'s source and target documents and types, on the right sides', async () => {
    const { m, src, tgt } = await acceptedMessage(co.A, co.B);
    const good = mirrorArgs(co.A, m, src, tgt);
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
    const { m, src, tgt } = await acceptedMessage(co.A, co.B);
    const args = mirrorArgs(co.A, m, src, tgt);
    const first = await asAppUser(pool, U.b, co.B, async (q) => (await q.query(LINK, args)).rows[0].id as string, true);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, args)).toBe('23505: duplicate key value violates unique constraint "intercompany_links_doc_a_live"');
    });
    // a second message that targets the SAME receiver document, with a new source document: only the receiver's side clashes
    const again = await acceptedMessage(co.A, co.B, { tgt });
    const side = co.B === low() ? 'a' : 'b';
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, mirrorArgs(co.A, again.m, again.src, tgt))).toBe(`23505: duplicate key value violates unique constraint "intercompany_links_doc_${side}_live"`);
    });
    await asAppUser(pool, U.b, co.B, (q) => q.query("UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [first]), true);
    await asAppUser(pool, U.b, co.B, async (q) => { expect(await outcome(q, LINK, args)).toBe('ok'); });
  });

  it('is refused on a revoked connection, with the pair out of order, or from a session of neither company', async () => {
    const { m, src, tgt } = await acceptedMessage(co.A, co.B);
    const args = mirrorArgs(co.A, m, src, tgt);
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
    const { m, src, tgt } = await acceptedMessage(co.A, co.B);
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

describe('a manual pairing', () => {
  const pairing = (a: string, b: string, aType = 'customer_invoice', bType = 'supplier_invoice') =>
    [id, null, low(), aType, a, high(), bType, b, 'manual_pairing'];

  it('starts pending with the inserter\'s side confirmed, and names no message', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const lowUser = low() === co.A ? U.a : U.b;
    const link = await asAppUser(pool, lowUser, low(), async (q) => (await q.query(LINK, pairing(a, b))).rows[0].id as string, true);
    expect(await linkRow(link)).toMatchObject({ status: 'pending_confirmation', confirmed_by_a: lowUser, confirmed_by_b: null, confirmed_at: null });
    const m = await plantMessage(pool, id, co.A, co.B);
    await asAppUser(pool, lowUser, low(), async (q) => {
      expect(await outcome(q, LINK, [id, m, low(), 'customer_invoice', crypto.randomUUID(), high(), 'supplier_invoice', crypto.randomUUID(), 'manual_pairing'])).toBe(R.manualNoMessage);
    });
  });

  it.each([
    ['customer_invoice', 'supplier_invoice'], ['supplier_invoice', 'customer_invoice'], ['credit_note', 'credit_note'],
  ] as const)('the inserter\'s own %s must exist in its own company (and %s on the other side is not checked by the inserter)', async (aType, bType) => {
    const a = await plantDocument(pool, aType, low());
    const b = await plantDocument(pool, bType, high());
    const lowUser = low() === co.A ? U.a : U.b;
    await asAppUser(pool, lowUser, low(), async (q) => {
      expect(await outcome(q, LINK, pairing(a, b, aType, bType))).toBe('ok');
      expect(await outcome(q, LINK, pairing(crypto.randomUUID(), crypto.randomUUID(), aType, bType))).toBe(R.docNotOwn);
      // the other company's document is not "own"
      expect(await outcome(q, LINK, pairing(b, crypto.randomUUID(), aType, bType))).toBe(R.docNotOwn);
    });
  });

  it('is confirmed by the OTHER party, then active; a confirmation is made once, by a user with a write role, as the user', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const lowUser = low() === co.A ? U.a : U.b;
    const highUser = high() === co.A ? U.a : U.b;
    const link = await asAppUser(pool, lowUser, low(), async (q) => (await q.query(LINK, pairing(a, b))).rows[0].id as string, true);
    const confirmB = "UPDATE intercompany_document_links SET confirmed_by_b = 'x' WHERE id = $1";
    // the inserting side cannot confirm the other side (it has no write role there)
    await asAppUser(pool, lowUser, low(), async (q) => { expect(await outcome(q, confirmB, [link])).toBe(R.linkConfirmRole); });
    // a viewer of the other company cannot
    const viewerOfHigh = high() === co.A ? U.va : U.avb;
    await asAppUser(pool, viewerOfHigh, high(), async (q) => { expect(await outcome(q, confirmB, [link])).toBe(R.linkConfirmRole); });
    await asAppUser(pool, highUser, high(), async (q) => { expect(await outcome(q, confirmB, [link])).toBe('ok'); }, true);
    expect(await linkRow(link)).toMatchObject({ status: 'active', confirmed_by_a: lowUser, confirmed_by_b: highUser });
    expect((await linkRow(link)).confirmed_at).toBeInstanceOf(Date);
    await asAppUser(pool, highUser, high(), async (q) => {
      expect(await outcome(q, confirmB, [link])).toBe(R.linkConfirmed);
      expect(await outcome(q, "UPDATE intercompany_document_links SET confirmed_by_b = NULL WHERE id = $1", [link])).toBe(R.linkConfirmed);
    });
  });

  it('a user with a write role in BOTH companies of a group may confirm both sides', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const link = await asAppUser(pool, U.ab, low(), async (q) => (await q.query(LINK, pairing(a, b))).rows[0].id as string, true);
    await asAppUser(pool, U.ab, low(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET confirmed_by_b = 'x' WHERE id = $1", [link])).toBe('ok');
    }, true);
    expect(await linkRow(link)).toMatchObject({ status: 'active', confirmed_by_a: U.ab, confirmed_by_b: U.ab });
  });

  it('the status cannot be set to active by the client; the stamps and everything else cannot change (trigger, as owner)', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const link = await asAppUser(pool, U.ab, low(), async (q) => (await q.query(LINK, pairing(a, b))).rows[0].id as string, true);
    await asOwner(pool, U.ab, low(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'active' WHERE id = $1", [link])).toBe(R.linkActivation);
      expect(await outcome(q, "UPDATE intercompany_document_links SET origin = 'mirror' WHERE id = $1", [link])).toBe(R.linkImmutable);
      expect(await outcome(q, 'UPDATE intercompany_document_links SET doc_a_id = gen_random_uuid() WHERE id = $1', [link])).toBe(R.linkImmutable);
      expect(await outcome(q, 'UPDATE intercompany_document_links SET doc_b_type = $2 WHERE id = $1', [link, 'credit_note'])).toBe(R.linkImmutable);
      expect(await outcome(q, 'UPDATE intercompany_document_links SET connection_id = gen_random_uuid() WHERE id = $1', [link])).toBe(R.linkImmutable);
      expect(await outcome(q, "UPDATE intercompany_document_links SET created_at = '2001-01-01' WHERE id = $1", [link])).toBe(R.linkImmutable);
      expect(await outcome(q, "UPDATE intercompany_document_links SET confirmed_at = now(), unlinked_by = 'x' WHERE id = $1", [link])).toBe('ok');
    }, true);
    const r = await linkRow(link);
    expect(r).toMatchObject({ status: 'pending_confirmation', confirmed_at: null, unlinked_by: null, unlinked_at: null });
  });

  it('a pairing made from the HIGH company checks its own document on the B side, and the LOW company confirms', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const highUser = high() === co.A ? U.a : U.b;
    const lowUser = low() === co.A ? U.a : U.b;
    await asAppUser(pool, highUser, high(), async (q) => {
      expect(await outcome(q, LINK, pairing(a, crypto.randomUUID()))).toBe(R.docNotOwn);
    });
    const link = await asAppUser(pool, highUser, high(), async (q) => (await q.query(LINK, pairing(crypto.randomUUID(), b))).rows[0].id as string, true);
    expect(await linkRow(link)).toMatchObject({ status: 'pending_confirmation', confirmed_by_a: null, confirmed_by_b: highUser });
    await asAppUser(pool, lowUser, low(), (q) => q.query("UPDATE intercompany_document_links SET confirmed_by_a = 'x' WHERE id = $1", [link]), true);
    expect(await linkRow(link)).toMatchObject({ status: 'active', confirmed_by_a: lowUser, confirmed_by_b: highUser });
  });

  it('either party may unlink; the stamps are server-side; an unlinked link is final; unlinking changes nothing else', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const link = await asAppUser(pool, U.ab, low(), async (q) => (await q.query(LINK, pairing(a, b))).rows[0].id as string, true);
    const highUser = high() === co.A ? U.a : U.b;
    await asAppUser(pool, highUser, high(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'unlinked', confirmed_by_b = 'x' WHERE id = $1", [link])).toBe(R.linkUnlinkOnly);
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [link])).toBe('ok');
    }, true);
    expect(await linkRow(link)).toMatchObject({ status: 'unlinked', unlinked_by: highUser });
    expect((await linkRow(link)).unlinked_at).toBeInstanceOf(Date);
    await asOwner(pool, U.ab, low(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'pending_confirmation' WHERE id = $1", [link])).toBe(R.linkFinal);
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [link])).toBe(R.linkFinal);
    });
  });

  it('a third company neither reads, confirms nor unlinks; no signed-in user, no change; the grant stops other columns', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const link = await asAppUser(pool, U.ab, low(), async (q) => (await q.query(LINK, pairing(a, b))).rows[0].id as string, true);
    await asAppUser(pool, U.c, co.C, async (q) => {
      expect((await q.query("UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [link])).rowCount).toBe(0);
      expect(await count(q, 'SELECT COUNT(*)::int AS n FROM intercompany_document_links')).toBe(0);
    });
    await asOwner(pool, null, low(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [link])).toBe(R.linkUser);
    });
    await asOwner(pool, U.ab, co.C, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [link])).toBe(R.linkParty);
    });
    await asAppUser(pool, U.ab, low(), async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_document_links SET doc_a_id = gen_random_uuid() WHERE id = $1', [link])).toBe('42501: permission denied for table intercompany_document_links');
      expect(await outcome(q, "UPDATE intercompany_document_links SET unlinked_by = 'x' WHERE id = $1", [link])).toBe('42501: permission denied for table intercompany_document_links');
      expect(await outcome(q, 'DELETE FROM intercompany_document_links')).toBe('42501: permission denied for table intercompany_document_links');
    });
  });
});
