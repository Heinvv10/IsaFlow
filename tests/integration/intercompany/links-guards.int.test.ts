/**
 * Intercompany (999z) links, the rules a review found missing: a viewer links nothing, a pairing is not confirmed after the
 * connection is revoked (it can still be unlinked), the confirmer's own document must exist in the confirmer's company, a
 * pending pairing holds no slot (a partner cannot squat a document), a message has one mirror link, and the mirror match
 * is NULL-safe.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import {
  asAppUser, asOwner, cleanup, co, outcome, plantConnection, plantDocument, plantMessage, R, setup, U, wipeConnections, withoutTrigger,
} from './intercompany.helpers';
import { LINK, acceptedMessage, high, linkRow, low, mirrorArgs, ownerOf, pairing } from './links.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

const CONFIRM_B = "UPDATE intercompany_document_links SET confirmed_by_b = 'x' WHERE id = $1";
const CONFIRM_A = "UPDATE intercompany_document_links SET confirmed_by_a = 'x' WHERE id = $1";
const UNLINK = "UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1";
const lowUser = () => ownerOf(low());
const highUser = () => ownerOf(high());
const viewerOf = (company: string) => (company === co.A ? U.va : U.avb);   // va views A only; avb owns A and views B

/** A pending pairing of fresh documents, made by the low company's writer. */
async function pending() {
  const a = await plantDocument(pool, 'customer_invoice', low());
  const b = await plantDocument(pool, 'supplier_invoice', high());
  const link = await asAppUser(pool, lowUser(), low(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
  return { a, b, link };
}

describe('a viewer links nothing', () => {
  it('cannot insert a mirror link or a manual pairing, nor unlink; a writer of the same company can', async () => {
    const { m, src, tgt } = await acceptedMessage(pool, id, co.A, co.B);
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    await asAppUser(pool, viewerOf(co.B), co.B, async (q) => {
      expect(await outcome(q, LINK, mirrorArgs(id, co.A, m, src, tgt))).toBe(R.linkWriteRole);
    });
    await asAppUser(pool, viewerOf(low()), low(), async (q) => {
      expect(await outcome(q, LINK, pairing(id, a, b))).toBe(R.linkWriteRole);
    });
    const { link } = await pending();
    await asAppUser(pool, viewerOf(high()), high(), async (q) => { expect(await outcome(q, UNLINK, [link])).toBe(R.linkWriteRole); });
    await asAppUser(pool, viewerOf(low()), low(), async (q) => { expect(await outcome(q, UNLINK, [link])).toBe(R.linkWriteRole); });
    await asAppUser(pool, highUser(), high(), async (q) => { expect(await outcome(q, UNLINK, [link])).toBe('ok'); });
  });
});

describe('a pairing is confirmed only on an active connection', () => {
  it('refuses a confirmation after the connection is revoked, and still lets either party unlink', async () => {
    const { link } = await pending();
    await asOwner(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    await asAppUser(pool, highUser(), high(), async (q) => { expect(await outcome(q, CONFIRM_B, [link])).toBe(R.linkConfirmActive); });
    await asAppUser(pool, U.ab, low(), async (q) => { expect(await outcome(q, CONFIRM_B, [link])).toBe(R.linkConfirmActive); });
    expect((await linkRow(pool, link)).status).toBe('pending_confirmation');
    await asAppUser(pool, highUser(), high(), async (q) => { expect(await outcome(q, UNLINK, [link])).toBe('ok'); }, true);
    expect((await linkRow(pool, link)).status).toBe('unlinked');
  });
});

describe("the confirmer's own document must exist in the confirmer's company", () => {
  /** A pending pairing whose HIGH-company document `b` is whatever the caller says (the inserter checks only its own side). */
  const pendingWith = async (b: string) => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    return asAppUser(pool, lowUser(), low(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
  };

  it('a made-up document, one of the wrong type and one that is the OTHER company\'s are refused at confirmation', async () => {
    const madeUp = await pendingWith(crypto.randomUUID());
    const wrongType = await pendingWith(await plantDocument(pool, 'credit_note', high()));       // exists, but as a credit note
    const lowsOwn = await pendingWith(await plantDocument(pool, 'supplier_invoice', low()));      // exists, in the LOW company
    for (const link of [madeUp, wrongType, lowsOwn]) {
      await asAppUser(pool, highUser(), high(), async (q) => { expect(await outcome(q, CONFIRM_B, [link])).toBe(R.docNotOwn); });
      expect((await linkRow(pool, link)).status).toBe('pending_confirmation');
    }
  });

  it('the same holds for the LOW side, confirmed by the low company after the high company paired', async () => {
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const link = await asAppUser(pool, highUser(), high(), async (q) => (await q.query(LINK, pairing(id, crypto.randomUUID(), b))).rows[0].id as string, true);
    await asAppUser(pool, lowUser(), low(), async (q) => { expect(await outcome(q, CONFIRM_A, [link])).toBe(R.docNotOwn); });
  });

  it('a user who writes in BOTH companies confirming both sides from one session meets the same check (the definer sees the other company)', async () => {
    const madeUp = await pendingWith(crypto.randomUUID());
    await asAppUser(pool, U.ab, low(), async (q) => { expect(await outcome(q, CONFIRM_B, [madeUp])).toBe(R.docNotOwn); });
    const real = await pending();
    await asAppUser(pool, U.ab, low(), async (q) => { expect(await outcome(q, CONFIRM_B, [real.link])).toBe('ok'); }, true);
    expect((await linkRow(pool, real.link)).status).toBe('active');
  });

  it('the definer check answers only for a company in which the caller writes: a viewer, a stranger and a made-up company get false', async () => {
    const real = await plantDocument(pool, 'supplier_invoice', high());
    const ask = (user: string, company: string, asCompany: string) => asAppUser(pool, user, company, async (q) =>
      (await q.query("SELECT public.intercompany_document_exists_as_writer('supplier_invoice', $1, $2) AS ok", [real, asCompany])).rows[0].ok as boolean);
    expect(await ask(highUser(), high(), high())).toBe(true);
    expect(await ask(U.ab, low(), high())).toBe(true);                  // writes in both, acting as the other company
    expect(await ask(viewerOf(high()), high(), high())).toBe(false);    // a viewer
    expect(await ask(U.c, co.C, high())).toBe(false);                   // a stranger
    expect(await ask(U.x, co.A, high())).toBe(false);                   // a member of nothing
    expect(await ask(highUser(), high(), low())).toBe(false);           // the document is not in that company
  });
});

describe('a pending pairing holds no slot', () => {
  it("a partner's pending pairing of a document does not stop the owner pairing it; only one of the two can be CONFIRMED", async () => {
    const a1 = await plantDocument(pool, 'customer_invoice', low());
    const a2 = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const make = (a: string) => asAppUser(pool, lowUser(), low(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
    const first = await make(a1);
    const second = await make(a2);                                       // not blocked by the first, which is only pending
    await asAppUser(pool, highUser(), high(), (q) => q.query(CONFIRM_B, [first]), true);
    expect((await linkRow(pool, first)).status).toBe('active');
    await asAppUser(pool, highUser(), high(), async (q) => {
      expect(await outcome(q, CONFIRM_B, [second])).toBe('23505: duplicate key value violates unique constraint "intercompany_links_doc_b_active"');
    });
    expect((await linkRow(pool, second)).status).toBe('pending_confirmation');
    // once the active link is unlinked the slot is free again
    await asAppUser(pool, highUser(), high(), (q) => q.query(UNLINK, [first]), true);
    await asAppUser(pool, highUser(), high(), async (q) => { expect(await outcome(q, CONFIRM_B, [second])).toBe('ok'); });
  });
});

describe('a pending pairing holds no slot on the LOW side either', () => {
  it('two pendings may name one low document; only one can be confirmed', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b1 = await plantDocument(pool, 'supplier_invoice', high());
    const b2 = await plantDocument(pool, 'supplier_invoice', high());
    const make = (b: string) => asAppUser(pool, highUser(), high(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
    const first = await make(b1);
    const second = await make(b2);
    await asAppUser(pool, lowUser(), low(), (q) => q.query(CONFIRM_A, [first]), true);
    expect((await linkRow(pool, first)).status).toBe('active');
    await asAppUser(pool, lowUser(), low(), async (q) => {
      expect(await outcome(q, CONFIRM_A, [second])).toBe('23505: duplicate key value violates unique constraint "intercompany_links_doc_a_active"');
    });
  });
});

describe('a message has one mirror link', () => {
  it('a second active mirror link for the same message is refused by the index alone (the guard is off to reach it)', async () => {
    const { m, src, tgt } = await acceptedMessage(pool, id, co.A, co.B);
    const first = mirrorArgs(id, co.A, m, src, tgt);
    await asAppUser(pool, ownerOf(co.B), co.B, (q) => q.query(LINK, first), true);
    await withoutTrigger(pool, 'intercompany_document_links', 'trg_intercompany_links_guard', async (q) => {
      await q.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.ab })]);
      const other = mirrorArgs(id, co.A, m, crypto.randomUUID(), crypto.randomUUID());
      expect(await outcome(q, LINK, other)).toBe('23505: duplicate key value violates unique constraint "intercompany_links_message_uq"');
    });
  });
});

describe('the mirror match is NULL-safe', () => {
  it('a payment message accepted with no target cannot be mirror-linked to arbitrary documents', async () => {
    const m = await plantMessage(pool, id, co.A, co.B, { kind: 'payment' });
    await asAppUser(pool, ownerOf(co.B), co.B, (q) => q.query("UPDATE intercompany_messages SET status = 'accepted' WHERE id = $1", [m]), true);
    const args = mirrorArgs(id, co.A, m, crypto.randomUUID(), crypto.randomUUID());
    await asAppUser(pool, ownerOf(co.B), co.B, async (q) => { expect(await outcome(q, LINK, args)).toBe(R.mirrorDocs); });
    const src = (await pool.query('SELECT source_doc_id FROM intercompany_messages WHERE id = $1', [m])).rows[0].source_doc_id as string;
    await asAppUser(pool, ownerOf(co.B), co.B, async (q) => {
      expect(await outcome(q, LINK, mirrorArgs(id, co.A, m, src, crypto.randomUUID()))).toBe(R.mirrorDocs);
    });
  });
});
