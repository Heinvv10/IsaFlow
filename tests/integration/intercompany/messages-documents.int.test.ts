/**
 * Intercompany (1002) messages and the documents they name. A message that carries a document (invoice, credit_note,
 * interest_invoice) names a source document that exists in the SENDING company and fits its kind; accepting it names the
 * document the receiver created for it, in the RECEIVING company and fitting the kind; a kind that creates no document
 * (payment, allocation, reject, credit_request) never carries a target. The mirror link re-checks, so a payment accepted
 * with a foreign invoice as its target, or an invoice message whose source is a third company's invoice, cannot become an
 * ACTIVE link.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import {
  asAppUser, asOwner, cleanup, co, outcome, plantConnection, payloadFor, plantDocument, plantMessage, R, setup, U, wipeConnections, withoutTrigger,
} from './intercompany.helpers';
import { LINK, linkRow, mirrorArgs } from './links.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

const SEND = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
              VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`;
// 1013: the DATABASE writes an invoice / credit-note message (app_user's own INSERT of one is refused: mirror-forged), so these send as the table
// owner with the sender's claims; every other rule of the guard (the source, the connection, the group, the write role) runs as it does for anyone.
const send = async (user: string, from: string, to: string, kind: string, type: string, doc: string) =>
  (kind === 'invoice' || kind === 'credit_note' ? asOwner : asAppUser)(pool, user, from, async (q) => outcome(q, SEND, [id, from, to, kind, type, doc, await payloadFor(pool, kind, doc, from)]));
const handle = (user: string, company: string, m: string, set: string) =>
  asAppUser(pool, user, company, (q) => outcome(q, `UPDATE intercompany_messages SET ${set} WHERE id = $1`, [m]), true);
const accepting = (type: string | null, doc: string | null) =>
  `status = 'accepted', target_doc_type = ${type ? `'${type}'` : 'NULL'}, target_doc_id = ${doc ? `'${doc}'` : 'NULL'}`;
const row = async (m: string) => (await pool.query('SELECT * FROM intercompany_messages WHERE id = $1', [m])).rows[0];

/** [kind, the sender's source type, the receiver's target type, the sender's credit-note type, the receiver's]. */
const KINDS = [
  ['invoice', 'customer_invoice', 'supplier_invoice'],
  ['interest_invoice', 'customer_invoice', 'supplier_invoice'],
  ['credit_note', 'credit_note', 'credit_note'],
] as const;

async function source(type: string, company: string) {
  return type === 'credit_note' ? plantDocument(pool, 'credit_note', company, U.ab, 'customer') : plantDocument(pool, type as 'customer_invoice', company);
}
async function target(type: string, company: string) {
  return type === 'credit_note' ? plantDocument(pool, 'credit_note', company, U.ab, 'supplier') : plantDocument(pool, type as 'supplier_invoice', company);
}

describe('sending: the source document is the sender\'s and fits the kind', () => {
  it.each(KINDS)('%s: a made-up document, a third company\'s, the receiver\'s, the wrong type and a missing one are refused; the sender\'s own is accepted', async (kind, srcType) => {
    const own = await source(srcType, co.A);
    const thirds = await source(srcType, co.C);
    const receivers = await source(srcType, co.B);
    expect(await send(U.a, co.A, co.B, kind, srcType, crypto.randomUUID())).toBe(R.msgSource);
    expect(await send(U.a, co.A, co.B, kind, srcType, thirds)).toBe(R.msgSource);            // attack B: another company's document
    expect(await send(U.a, co.A, co.B, kind, srcType, receivers)).toBe(R.msgSource);
    // even for a user who belongs to the other company too (so RLS shows them its documents)
    expect(await send(U.ab, co.A, co.B, kind, srcType, receivers)).toBe(R.msgSource);
    expect(await send(U.ac, co.A, co.B, kind, srcType, thirds)).toBe(R.msgSource);
    expect(await send(U.a, co.A, co.B, kind, srcType === 'credit_note' ? 'customer_invoice' : 'credit_note', own)).toBe(R.msgSource);   // wrong type for the kind
    expect(await send(U.a, co.A, co.B, kind, 'journal_entry', own)).toBe(R.msgSource);
    expect(await send(U.a, co.A, co.B, kind, srcType, own)).toBe('ok');
  });

  it('a credit note message needs a CUSTOMER credit note (the sender issues it); a supplier credit note is refused', async () => {
    const supplierSide = await plantDocument(pool, 'credit_note', co.A, U.ab, 'supplier');
    expect(await send(U.a, co.A, co.B, 'credit_note', 'credit_note', supplierSide)).toBe(R.msgSource);
  });

  it('a kind that carries no document (payment, allocation, reject, credit_request) names a row id and is not checked', async () => {
    for (const kind of ['payment', 'allocation', 'reject', 'credit_request']) {
      expect(await send(U.a, co.A, co.B, kind, 'payment', crypto.randomUUID()), kind).toBe('ok');
    }
  });
});

describe('accepting: the target is the receiver\'s and fits the kind', () => {
  it.each(KINDS)('%s: no target, a made-up one, the sender\'s, a third company\'s and the wrong type are refused; the receiver\'s own is accepted', async (kind, _src, tgtType) => {
    const m = await plantMessage(pool, id, co.A, co.B, { kind });
    const own = await target(tgtType, co.B);
    const senders = await target(tgtType, co.A);
    const thirds = await target(tgtType, co.C);
    expect(await handle(U.b, co.B, m, accepting(null, null))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting(tgtType, null))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting(null, own))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting(tgtType, crypto.randomUUID()))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting(tgtType, senders))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting(tgtType, thirds))).toBe(R.msgTarget);
    expect(await handle(U.ab, co.B, m, accepting(tgtType, senders))).toBe(R.msgTarget);        // sees the sender's document, still refused
    expect(await handle(U.b, co.B, m, accepting('journal_entry', own))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting(tgtType === 'credit_note' ? 'supplier_invoice' : 'customer_invoice', own))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting(tgtType, own))).toBe('ok');
  });

  it('a target that does not fit the kind is refused: an invoice targeting a credit note, a credit note targeting an invoice or a CUSTOMER credit note', async () => {
    const inv = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    const cn = await plantMessage(pool, id, co.A, co.B, { kind: 'credit_note' });
    const supplierCredit = await plantDocument(pool, 'credit_note', co.B, U.ab, 'supplier');
    const customerCredit = await plantDocument(pool, 'credit_note', co.B, U.ab, 'customer');
    const supplierInvoice = await plantDocument(pool, 'supplier_invoice', co.B);
    expect(await handle(U.b, co.B, inv, accepting('credit_note', supplierCredit))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, cn, accepting('supplier_invoice', supplierInvoice))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, cn, accepting('credit_note', customerCredit))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, cn, accepting('credit_note', supplierCredit))).toBe('ok');
  });

  it('a target set without accepting (a retry, a rejection) is checked too', async () => {
    const m = await plantMessage(pool, id, co.A, co.B);
    const thirds = await plantDocument(pool, 'supplier_invoice', co.C);
    expect(await handle(U.b, co.B, m, `status = 'failed', error = 'x', target_doc_type = 'supplier_invoice', target_doc_id = '${thirds}'`)).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, `status = 'rejected', reason = 'r', target_doc_type = 'supplier_invoice', target_doc_id = '${thirds}'`)).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, "status = 'rejected', reason = 'wrong amount'")).toBe('ok');
  });

  it.each([['payment'], ['allocation'], ['reject'], ['credit_request']])('%s creates no document: whatever target is sent is cleared, on accepting and on any other update', async (kind) => {
    const m = await plantMessage(pool, id, co.A, co.B, { kind });
    const thirds = await plantDocument(pool, 'customer_invoice', co.C);                        // attack A
    expect(await handle(U.b, co.B, m, accepting('customer_invoice', thirds))).toBe('ok');
    expect(await row(m)).toMatchObject({ status: 'accepted', target_doc_type: null, target_doc_id: null });
    const f = await plantMessage(pool, id, co.A, co.B, { kind });
    await handle(U.b, co.B, f, `status = 'failed', error = 'x', target_doc_type = 'supplier_invoice', target_doc_id = '${thirds}'`);
    expect(await row(f)).toMatchObject({ status: 'failed', target_doc_type: null, target_doc_id: null });
  });
});

describe('a receiver document is the target of ONE accepted message per receiving company', () => {
  it('a second message naming it is refused (and one that targets another document is not)', async () => {
    const tgt = await plantDocument(pool, 'supplier_invoice', co.B);
    const first = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    const second = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    const other = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    expect(await handle(U.b, co.B, first, accepting('supplier_invoice', tgt))).toBe('ok');
    expect(await handle(U.b, co.B, second, accepting('supplier_invoice', tgt))).toBe(R.msgTargetTaken);
    expect(await handle(U.b, co.B, other, accepting('supplier_invoice', await plantDocument(pool, 'supplier_invoice', co.B)))).toBe('ok');
    // still pending, so it can be rejected or accepted against a document of its own
    expect(await handle(U.b, co.B, second, accepting('supplier_invoice', await plantDocument(pool, 'supplier_invoice', co.B)))).toBe('ok');
  });

  it('only an ACCEPTED message holds it: rejected and failed ones that carry the same target do not, and the document can still be accepted', async () => {
    const tgt = await plantDocument(pool, 'supplier_invoice', co.B);
    const rejected = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    const failed = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    const wins = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    expect(await handle(U.b, co.B, rejected, `status = 'rejected', reason = 'r', target_doc_type = 'supplier_invoice', target_doc_id = '${tgt}'`)).toBe('ok');
    expect(await handle(U.b, co.B, failed, `status = 'failed', error = 'x', target_doc_type = 'supplier_invoice', target_doc_id = '${tgt}'`)).toBe('ok');
    expect(await handle(U.b, co.B, wins, accepting('supplier_invoice', tgt))).toBe('ok');
  });

  it('it is per RECEIVING COMPANY, not per connection: another connection of the receiver, or a replacement of a revoked pair, cannot take the document again', async () => {
    const tgt = await plantDocument(pool, 'supplier_invoice', co.B);
    await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'owner')", [co.C, U.b]);   // a writer of both B and C
    const k = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC target group K')", [k]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [k, co.B, co.C]);
    try {
      const other = await plantConnection(pool, co.B, co.C, U.b);
      const first = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
      const second = await plantMessage(pool, other, co.C, co.B, { kind: 'invoice', user: U.b });
      expect(await handle(U.b, co.B, first, accepting('supplier_invoice', tgt))).toBe('ok');
      expect(await handle(U.b, co.B, second, accepting('supplier_invoice', tgt))).toBe(R.msgTargetTaken);      // another connection of B
      expect(await handle(U.b, co.B, second, accepting('supplier_invoice', await plantDocument(pool, 'supplier_invoice', co.B)))).toBe('ok');
      // the pair A-B is revoked and replaced by a new row (the live-pair index allows it): the old accept still holds the document
      await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
      await pool.query('DELETE FROM intercompany_messages WHERE id = $1', [second]);
      const replacement = await plantConnection(pool, co.A, co.B);
      const third = await plantMessage(pool, replacement, co.A, co.B, { kind: 'invoice' });
      expect(await handle(U.b, co.B, third, accepting('supplier_invoice', tgt))).toBe(R.msgTargetTaken);
    } finally {
      await pool.query('DELETE FROM intercompany_messages WHERE connection_id IN (SELECT id FROM intercompany_connections WHERE company_low_id = ANY($1) AND company_high_id = ANY($1) AND NOT (company_low_id = ANY($2) AND company_high_id = ANY($2)))', [[co.B, co.C], [co.A, co.B]]);
      await pool.query('DELETE FROM intercompany_connections WHERE company_low_id = ANY($1) AND company_high_id = ANY($1) AND NOT (company_low_id = ANY($2) AND company_high_id = ANY($2))', [[co.B, co.C], [co.A, co.B]]);
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [k]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [k]);
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [co.C, U.b]);
    }
  });

  it('the index holds when the guard cannot see the other writer (guard off): 23505', async () => {
    const tgt = await plantDocument(pool, 'supplier_invoice', co.B);
    const first = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    const second = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    await handle(U.b, co.B, first, accepting('supplier_invoice', tgt));
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', async (q) => {
      expect(await outcome(q, `UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'supplier_invoice', target_doc_id = $2 WHERE id = $1`, [second, tgt]))
        .toBe('23505: duplicate key value violates unique constraint "intercompany_messages_target_uq"');
    });
  });

  it('two concurrent accepts of one document: one wins, the other is refused, neither deadlocks', async () => {
    const tgt = await plantDocument(pool, 'supplier_invoice', co.B);
    const a = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    const b = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    const run = (m: string) => asAppUser(pool, U.b, co.B, (q) => outcome(q, `UPDATE intercompany_messages SET ${accepting('supplier_invoice', tgt)} WHERE id = $1`, [m]), true);
    const results = await Promise.all([run(a), run(b)]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.find((r) => r !== 'ok')).toMatch(/^(23514: a document is the target of one accepted message per receiving company|23505: duplicate key value violates unique constraint "intercompany_messages_target_uq")$/);
  });
});

describe('intercompany_message_documents_ok answers the receiver only', () => {
  it('true for the receiving session when both documents fit; false for the sender, a third company and a message that does not fit', async () => {
    const src = await plantDocument(pool, 'customer_invoice', co.A);
    const m = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice', doc: src });
    const tgt = await plantDocument(pool, 'supplier_invoice', co.B);
    await handle(U.b, co.B, m, accepting('supplier_invoice', tgt));
    const ok = (user: string, company: string, message: string) =>
      asAppUser(pool, user, company, async (q) => (await q.query('SELECT public.intercompany_message_documents_ok($1) AS ok', [message])).rows[0].ok as boolean);
    expect(await ok(U.b, co.B, m)).toBe(true);
    expect(await ok(U.a, co.A, m)).toBe(false);          // the sender's session
    expect(await ok(U.ab, co.A, m)).toBe(false);
    expect(await ok(U.c, co.C, m)).toBe(false);
    // the session company is a GUC any session can set: it makes nobody the receiver
    expect(await ok(U.x, co.B, m)).toBe(false);
    expect(await ok(U.c, co.B, m)).toBe(false);
    await asOwner(pool, null, co.B, async (q) => { expect((await q.query('SELECT public.intercompany_message_documents_ok($1) AS ok', [m])).rows[0].ok).toBe(false); });
    expect(await ok(U.b, co.B, crypto.randomUUID())).toBe(false);
    const pending = await plantMessage(pool, id, co.A, co.B, { kind: 'interest_invoice' });      // no target yet
    expect(await ok(U.b, co.B, pending)).toBe(false);
    const payment = await plantMessage(pool, id, co.A, co.B, { kind: 'payment' });               // a kind that carries no document
    await handle(U.b, co.B, payment, "status = 'accepted'");
    expect(await ok(U.b, co.B, payment)).toBe(false);
  });
});

describe('the mirror link re-checks, so neither attack reaches an ACTIVE link', () => {
  it('attack A: a payment accepted with a third company\'s invoice as its target cannot be mirror-linked (kind refused, and nothing was stored)', async () => {
    const m = await plantMessage(pool, id, co.A, co.B, { kind: 'payment' });
    const thirds = await plantDocument(pool, 'customer_invoice', co.C);
    await handle(U.b, co.B, m, accepting('customer_invoice', thirds));
    const src = (await row(m)).source_doc_id as string;
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, mirrorArgs(id, co.A, m, src, thirds))).toBe(R.mirrorKind);
    });
  });

  it('a payment message that somehow carries an accepted target (the message guard is off to plant it) is still refused by the kind', async () => {
    const m = await plantMessage(pool, id, co.A, co.B, { kind: 'payment' });
    const own = await plantDocument(pool, 'supplier_invoice', co.B);
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) =>
      q.query("UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'supplier_invoice', target_doc_id = $2 WHERE id = $1", [m, own]));
    const src = (await row(m)).source_doc_id as string;
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, mirrorArgs(id, co.A, m, src, own))).toBe(R.mirrorKind);
    });
  });

  it("attack B: an invoice message whose source is a third company's invoice cannot be sent; planted with the message guard off, its mirror link is still refused", async () => {
    const thirds = await plantDocument(pool, 'customer_invoice', co.C);
    expect(await send(U.a, co.A, co.B, 'invoice', 'customer_invoice', thirds)).toBe(R.msgSource);
    const m = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    const own = await plantDocument(pool, 'supplier_invoice', co.B);
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) =>
      q.query("UPDATE intercompany_messages SET source_doc_id = $2, status = 'accepted', target_doc_type = 'supplier_invoice', target_doc_id = $3 WHERE id = $1", [m, thirds, own]));
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, mirrorArgs(id, co.A, m, thirds, own))).toBe(R.mirrorDocs);
    });
    expect((await pool.query('SELECT count(*)::int AS n FROM intercompany_document_links WHERE connection_id = $1', [id])).rows[0].n).toBe(0);
  });

  it("a message whose target is not the receiver's (planted with the message guard off) is refused at the link", async () => {
    const m = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice' });
    const senders = await plantDocument(pool, 'supplier_invoice', co.A);
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) =>
      q.query("UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'supplier_invoice', target_doc_id = $2 WHERE id = $1", [m, senders]));
    const src = (await row(m)).source_doc_id as string;
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, LINK, mirrorArgs(id, co.A, m, src, senders))).toBe(R.mirrorDocs);
    });
  });

  it('the legitimate flow still links: invoice sent with its own document, accepted with the receiver\'s own, linked and active', async () => {
    const src = await plantDocument(pool, 'customer_invoice', co.A);
    const m = await plantMessage(pool, id, co.A, co.B, { kind: 'invoice', doc: src });
    const tgt = await plantDocument(pool, 'supplier_invoice', co.B);
    expect(await handle(U.b, co.B, m, accepting('supplier_invoice', tgt))).toBe('ok');
    const link = await asAppUser(pool, U.b, co.B, async (q) => (await q.query(LINK, mirrorArgs(id, co.A, m, src, tgt))).rows[0].id as string, true);
    expect(await linkRow(pool, link)).toMatchObject({ status: 'active', origin: 'mirror' });
  });
});
