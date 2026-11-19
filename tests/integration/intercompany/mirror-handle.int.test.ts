/**
 * Intercompany P2, the RECEIVER's inbox, through the real routes as app_user across three tenants (A sends, B receives, C is a
 * stranger in another group). The rest of the receiver's side: accepting a credit note, reject / dismiss / restore, what cannot be
 * accepted (foreign currency, a payload that does not add up, a revoked connection, a viewer), the list, and tenancy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { enableFxDocuments } from '../r035-approval.helpers';
import { asAppUser, count, pairOf, withoutTrigger } from './intercompany.helpers';
import {
  acct, acc, approveInvoice, co, connect, dataOf, errorOf, inbox, mirrorCleanup, mirrorSetup, party, plantArCreditNote, plantArInvoice,
  U, asService, clearMirrorRows, sentInvoice as sentInvoiceIn, approveCreditNoteRow,
} from './mirror.helpers';
import { mirrorApprovedCreditNote } from '../../../src/modules/accounting/services/intercompany/outboxService';
import { acceptMessage } from '../../../src/modules/accounting/services/intercompany/acceptService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(async () => {
  await clearMirrorRows(pool);
  conn = await connect(pool);
});

const sentInvoice = (over: Parameters<typeof plantArInvoice>[1] = {}) => sentInvoiceIn(pool, over);
const bills = async () => (await pool.query('SELECT * FROM supplier_invoices WHERE company_id = $1 ORDER BY created_at', [co.B])).rows;
const notes = async () => (await pool.query("SELECT * FROM credit_notes WHERE company_id = $1 AND type = 'supplier'", [co.B])).rows;
const messageRow = async (id: string) => (await pool.query('SELECT * FROM intercompany_messages WHERE id = $1', [id])).rows[0];
const links = async () => (await pool.query('SELECT * FROM intercompany_document_links WHERE company_a_id = $1 OR company_b_id = $1', [co.A])).rows;
const accept = (id: string, body?: unknown, user = U.b) => inbox.accept(user, co.B, id, body);

/** A customer credit note of A, approved, and the message it left for B. */
async function sentCreditNote(date?: string) {
  const cn = await plantArCreditNote(pool, { date });
  await approveCreditNoteRow(pool, cn);
  await asService(pool, U.a, co.A, () => mirrorApprovedCreditNote(co.A, cn));
  const message = (await pool.query('SELECT * FROM intercompany_messages WHERE source_doc_id = $1', [cn])).rows[0];
  return { cn, id: message.id as string, message };
}

describe('accepting a credit note', () => {
  it('creates a draft supplier credit note with the sender\'s exact VAT; the sender\'s number is in its reason, for people', async () => {
    const { cn, id } = await sentCreditNote();
    const res = await accept(id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const [note] = await notes();
    expect(note).toMatchObject({ type: 'supplier', supplier_id: party.bSupplier, status: 'draft', gl_account_id: acc.bExp1 });
    expect([Number(note.subtotal), Number(note.tax_amount), Number(note.total_amount)]).toEqual([200, 30, 230]);
    expect(String(note.reason)).toContain(`ICCN-${cn.slice(0, 8)}`);
    expect((await messageRow(id))).toMatchObject({ status: 'accepted', target_doc_type: 'credit_note', target_doc_id: note.id });
    expect((await links())[0]).toMatchObject({ status: 'active', origin: 'mirror' });
    // an accepted message is final: the guard refuses to reopen it
    expect(await pool.query("UPDATE intercompany_messages SET status = 'pending' WHERE id = $1", [id]).catch(() => null)).toBeNull();
  });

  it('a second message from the same sender with the same credit note number is a duplicate: refused (409), no second draft; the reason text plays no part', async () => {
    const first = await sentCreditNote();
    expect((await accept(first.id)).state.statusCode).toBe(200);
    // Edit the first note\'s reason: the duplicate check must not read it (it is an editable field).
    await pool.query("UPDATE credit_notes SET reason = 'edited by a person' WHERE company_id = $1 AND type = 'supplier'", [co.B]);
    // A second message with the same sender number (a re-issued document): planted with the guard off, because a sender cannot reuse a number.
    const second = await plantArCreditNote(pool, { date: '2026-09-06' });
    await approveCreditNoteRow(pool, second);
    const dup = await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', async (q) => (await q.query(
      `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
       VALUES ($1, $2, $3, 'credit_note', 'credit_note', $4, $5::jsonb) RETURNING id`, [conn, co.A, co.B, second, JSON.stringify(first.message.payload)])).rows[0].id as string);
    const res = await accept(dup);
    expect(res.state.statusCode).toBe(409);
    expect(errorOf(res)).toMatch(/already exists/);
    expect(await notes()).toHaveLength(1);
    expect((await messageRow(dup)).status).toBe('pending');
    // once that note is cancelled it no longer blocks
    await pool.query("UPDATE credit_notes SET status = 'cancelled' WHERE company_id = $1 AND type = 'supplier'", [co.B]);
    expect((await accept(dup)).state.statusCode).toBe(200);
  });

  it('a credit note carries exactly one line, whatever a sender says', async () => {
    const { id, message } = await sentCreditNote();
    // two lines that add up to the note (R100 + R100, VAT R15 each): consistent in every figure, so only 'a credit note is one line' stops it
    const half = { ...message.payload.lines[0], unitPrice: 100, lineTotal: 100, taxAmount: 15 };
    const two = { ...message.payload, lines: [half, { ...half, description: 'Second half' }] };
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) =>
      q.query('UPDATE intercompany_messages SET payload = $2::jsonb WHERE id = $1', [id, JSON.stringify(two)]));
    const preview = dataOf<{ blockers: string[] }>(await inbox.get(U.b, co.B, id));
    expect(preview.blockers.join(' ')).toMatch(/A credit note is one line/);
    expect((await accept(id)).state.statusCode).toBe(409);
    expect(await notes()).toHaveLength(0);
  });
});

describe('rejecting, dismissing and restoring', () => {
  it('reject needs a reason; it goes back to the sender\'s outbox; the sender\'s invoice is untouched', async () => {
    const { inv, id } = await sentInvoice();
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 7 }, { reason: 'x'.repeat(2001) }, { reason: 'ok', extra: 1 }]) {
      expect((await inbox.reject(U.b, co.B, id, body)).state.statusCode).toBe(400);
    }
    expect((await messageRow(id)).status).toBe('pending');
    const res = await inbox.reject(U.b, co.B, id, { reason: '  Wrong entity: bill Velocity  ' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await messageRow(id)).toMatchObject({ status: 'rejected', reason: 'Wrong entity: bill Velocity', handled_by: U.b });
    const seenBySender = await asAppUser(pool, U.a, co.A, async (q) => (await q.query('SELECT status, reason FROM intercompany_messages WHERE id = $1', [id])).rows[0]);
    expect(seenBySender).toEqual({ status: 'rejected', reason: 'Wrong entity: bill Velocity' });
    expect((await pool.query('SELECT status FROM customer_invoices WHERE id = $1', [inv.id])).rows[0].status).toBe('approved');
    expect(await bills()).toHaveLength(0);
    // final
    expect((await accept(id)).state.statusCode).toBe(409);
    expect((await inbox.reject(U.b, co.B, id, { reason: 'again' })).state.statusCode).toBe(409);
  });

  it('dismiss sets it aside (not acceptable) and restore brings it back', async () => {
    const { id } = await sentInvoice();
    expect((await inbox.dismiss(U.b, co.B, id)).state.statusCode).toBe(200);
    expect((await messageRow(id)).status).toBe('dismissed');
    const refused = await accept(id);
    expect(refused.state.statusCode).toBe(409);
    expect(errorOf(refused)).toMatch(/Restore it first/);
    expect((await inbox.dismiss(U.b, co.B, id)).state.statusCode).toBe(409);
    expect((await inbox.restore(U.b, co.B, id)).state.statusCode).toBe(200);
    expect((await messageRow(id)).status).toBe('pending');
    expect((await accept(id)).state.statusCode).toBe(200);
    expect((await inbox.restore(U.b, co.B, id)).state.statusCode).toBe(409);
  });
});

describe('what cannot be accepted', () => {
  it('a foreign-currency invoice is blocked with a ZAR-only sentence; it can still be rejected', async () => {
    await enableFxDocuments(pool, co.A);
    const { id } = await sentInvoice({ currency: 'USD' });
    const preview = dataOf<{ blockers: string[]; item: { blocker: string } }>(await inbox.get(U.b, co.B, id));
    expect(preview.blockers.join(' ')).toMatch(/ZAR only/);
    const res = await accept(id);
    expect(res.state.statusCode).toBe(409);
    expect(errorOf(res)).toMatch(/ZAR only/);
    expect(await bills()).toHaveLength(0);
    expect((await inbox.reject(U.b, co.B, id, { reason: 'Capture it by hand' })).state.statusCode).toBe(200);
  });

  it('a payload that does not add up, or names a PDF outside the sender\'s storage, is blocked and writes nothing', async () => {
    const { id, message } = await sentInvoice();
    const tamper = async (patch: Record<string, unknown>) => {
      await pool.query('ALTER TABLE intercompany_messages DISABLE TRIGGER trg_intercompany_messages_guard');
      try {
        await pool.query("UPDATE intercompany_messages SET payload = payload || $2::jsonb WHERE id = $1", [id, JSON.stringify(patch)]);
      } finally {
        await pool.query('ALTER TABLE intercompany_messages ENABLE ALWAYS TRIGGER trg_intercompany_messages_guard');
      }
    };
    for (const patch of [
      { total: 9999 },
      { pdf: { path: `${co.C}/${crypto.randomUUID()}.pdf`, sha256: 'a'.repeat(64) } },
      { pdf: { path: `${co.A}/../${co.C}/x.pdf`, sha256: 'a'.repeat(64) } },
    ]) {
      await tamper(patch);
      const preview = dataOf<{ blockers: string[] }>(await inbox.get(U.b, co.B, id));
      expect(preview.blockers.length).toBeGreaterThan(0);
      const res = await accept(id);
      expect(res.state.statusCode).toBe(409);
      expect(await bills()).toHaveLength(0);
      await tamper({ total: message.payload.total, pdf: null });
    }
  });

  it('a revoked connection: accept and reject are refused, dismiss still works', async () => {
    const { id } = await sentInvoice();
    await asAppUser(pool, U.a, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [conn]), true);
    expect((await accept(id)).state.statusCode).toBe(409);
    expect((await inbox.reject(U.b, co.B, id, { reason: 'x' })).state.statusCode).toBe(409);
    expect(await bills()).toHaveLength(0);
    expect((await inbox.dismiss(U.b, co.B, id)).state.statusCode).toBe(200);
  });

  it('a viewer of the receiving company cannot accept, reject or dismiss', async () => {
    const { id } = await sentInvoice();
    expect((await accept(id, undefined, U.avb)).state.statusCode).toBe(403);
    expect((await inbox.reject(U.avb, co.B, id, { reason: 'no' })).state.statusCode).toBe(403);
    expect((await inbox.dismiss(U.avb, co.B, id)).state.statusCode).toBe(403);
    expect((await messageRow(id)).status).toBe('pending');
    expect(await bills()).toHaveLength(0);
  });
});

describe('the inbox list', () => {
  it('lists what needs a person with the badge count, and the handled ones apart', async () => {
    const one = await sentInvoice();
    const two = await sentInvoice();
    const open = dataOf<{ items: Array<{ id: string; number: string; total: number; status: string }>; total: number; openCount: number }>(await inbox.list(U.b, co.B));
    expect(open.openCount).toBe(2);
    expect(open.total).toBe(2);
    expect(open.items.map((i) => i.id).sort()).toEqual([one.id, two.id].sort());
    expect(open.items[0]).toMatchObject({ total: 1150, status: 'pending' });
    expect(dataOf(await inbox.count(U.b, co.B))).toEqual({ openCount: 2, enabled: true });
    expect(dataOf(await inbox.count(U.c, co.C))).toEqual({ openCount: 0, enabled: false });
    expect((await accept(one.id)).state.statusCode).toBe(200);
    expect(dataOf<{ openCount: number }>(await inbox.list(U.b, co.B)).openCount).toBe(1);
    const handled = dataOf<{ items: Array<{ id: string; status: string; handledVia: string }> }>(await inbox.list(U.b, co.B, { filter: 'handled' }));
    expect(handled.items).toHaveLength(1);
    expect(handled.items[0]).toMatchObject({ id: one.id, status: 'accepted', handledVia: 'user' });
    for (const bad of [{ filter: 'all' }, { limit: 'x' }, { offset: '-1' }]) expect((await inbox.list(U.b, co.B, bad)).state.statusCode).toBe(400);
  });
});

describe('tenancy', () => {
  it('a third company\'s inbox is empty and it can read, accept, reject or dismiss none of B\'s messages', async () => {
    const { id } = await sentInvoice();
    expect(dataOf<{ total: number; openCount: number }>(await inbox.list(U.c, co.C))).toMatchObject({ total: 0, openCount: 0 });
    expect((await inbox.get(U.c, co.C, id)).state.statusCode).toBe(404);
    expect((await accept(id, undefined, U.c)).state.statusCode).toBe(403); // C is not a member of B: withAuth refuses
    expect((await inbox.accept(U.c, co.C, id)).state.statusCode).toBe(404);
    expect((await inbox.reject(U.c, co.C, id, { reason: 'x' })).state.statusCode).toBe(404);
    expect((await inbox.dismiss(U.c, co.C, id)).state.statusCode).toBe(404);
    expect((await messageRow(id)).status).toBe('pending');
    expect(await count(pool, 'SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1', [co.C])).toBe(0);
  });

  it('the sender cannot accept, reject or read the message as an inbox item, and cannot change its handling', async () => {
    const { id } = await sentInvoice();
    expect(dataOf<{ total: number }>(await inbox.list(U.a, co.A)).total).toBe(0);
    expect((await inbox.get(U.a, co.A, id)).state.statusCode).toBe(404);
    expect((await inbox.accept(U.a, co.A, id)).state.statusCode).toBe(404);
    expect((await inbox.reject(U.a, co.A, id, { reason: 'x' })).state.statusCode).toBe(404);
    const changed = await asAppUser(pool, U.a, co.A, async (q) => (await q.query("UPDATE intercompany_messages SET status = 'accepted' WHERE id = $1", [id])).rowCount, true);
    expect(changed).toBe(0);
    expect((await messageRow(id)).status).toBe('pending');
  });

  it('B\'s accept leaves no row in A\'s or C\'s books', async () => {
    const before = await count(pool, 'SELECT count(*) AS n FROM supplier_invoices WHERE company_id <> $1', [co.B]);
    const { id } = await sentInvoice();
    expect((await accept(id)).state.statusCode).toBe(200);
    expect(await count(pool, 'SELECT count(*) AS n FROM supplier_invoices WHERE company_id <> $1', [co.B])).toBe(before);
    expect(await count(pool, "SELECT count(*) AS n FROM credit_notes WHERE type = 'supplier' AND company_id = ANY($1)", [[co.A, co.C]])).toBe(0);
  });
});
