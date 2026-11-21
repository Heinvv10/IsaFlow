/**
 * Intercompany P2, the SENDER's outbox, against a real database as app_user: approving a customer invoice or customer credit note
 * for a customer that is the partner on an ACTIVE connection (document date on or after the cut-over) leaves exactly ONE message
 * for the partner, in the sender's own transaction, and nothing else changes in anyone's books. A retry or a re-send writes no
 * second message; before the cut-over, with no cut-over, with no connection, a revoked one or an unlinked customer: no message.
 * A foreign-currency document is still sent (the receiver refuses it). The approval never fails because a mirror could not be written.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { mirrorApprovedCreditNote, mirrorApprovedInvoice } from '../../../src/modules/accounting/services/intercompany/outboxService';
import { approveCreditNote } from '../../../src/modules/accounting/services/ar/creditNoteApproveService';
import { vi } from 'vitest';
import { log } from '@/lib/logger';
import { enableFxDocuments } from '../r035-approval.helpers';
import { asAppUser, asDefiner, count } from './intercompany.helpers';
import {
  approveInvoice, asService, co, connect, mirrorCleanup, mirrorSetup, party, plantArCreditNote, plantArInvoice, U, wipeConnections,
} from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(async () => {
  await pool.query('DELETE FROM intercompany_transactions WHERE group_id = $1', [co.G]);
  await wipeConnections(pool);
  conn = await connect(pool);
});

const messages = async (source?: string) => (await pool.query(
  `SELECT * FROM intercompany_messages WHERE from_company_id = $1 ${source ? 'AND source_doc_id = $2' : ''} ORDER BY created_at`,
  source ? [co.A, source] : [co.A])).rows;
const gtx = async () => (await pool.query('SELECT * FROM intercompany_transactions WHERE group_id = $1', [co.G])).rows;
const send = (id: string) => asService(pool, U.a, co.A, () => mirrorApprovedInvoice(co.A, id));

describe('approving an invoice for a connected customer', () => {
  it('leaves exactly one message for the partner, with the invoice cents-exact, and the sender\'s own group row', async () => {
    const inv = await plantArInvoice(pool);
    const res = await approveInvoice(inv.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const rows = await messages(inv.id);
    expect(rows).toHaveLength(1);
    const m = rows[0];
    expect(m).toMatchObject({ kind: 'invoice', status: 'pending', from_company_id: co.A, to_company_id: co.B, connection_id: conn, source_doc_type: 'customer_invoice' });
    expect(m.payload).toMatchObject({
      version: 1, kind: 'invoice', number: inv.number, date: '2026-09-01', currency: 'ZAR', subtotal: 1000, taxAmount: 150, total: 1150,
    });
    expect(m.payload.lines).toHaveLength(2);
    expect(m.payload.groupTransactionId).toBeTruthy();
    const g = await gtx();
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ id: m.payload.groupTransactionId, source_company_id: co.A, target_company_id: co.B, transaction_type: 'sale', match_status: 'unmatched' });
    expect(Number(g[0].amount)).toBe(1000);
    // nothing in B's books
    expect(await count(pool, 'SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1', [co.B])).toBe(0);
    expect(await count(pool, 'SELECT count(*) AS n FROM intercompany_document_links WHERE company_a_id = $1 OR company_b_id = $1', [co.A])).toBe(0);
  });

  it('a retry or a second send writes no second message and no second group row', async () => {
    const inv = await plantArInvoice(pool);
    expect((await approveInvoice(inv.id)).state.statusCode).toBe(200);
    expect(await send(inv.id)).toEqual({ sent: false, reason: 'already_sent' });
    expect(await send(inv.id)).toEqual({ sent: false, reason: 'already_sent' });
    expect(await messages(inv.id)).toHaveLength(1);
    expect(await gtx()).toHaveLength(1);
    // the sender's own INSERT of a document message is refused (the database writes it), and the database's own key refuses a second one
    const payload = JSON.stringify((await messages(inv.id))[0].payload);
    const insert = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
                    VALUES ($1, $2, $3, 'invoice', 'customer_invoice', $4, $5::jsonb)`;
    await asAppUser(pool, U.a, co.A, (q) => expect(q.query(insert, [conn, co.A, co.B, inv.id, payload])).rejects.toMatchObject({ code: '42501' }));
    await asDefiner(pool, U.a, co.A, (q) => expect(q.query(insert, [conn, co.A, co.B, inv.id, payload])).rejects.toMatchObject({ code: '23505' }));
  });

  it('a second approval of the same invoice is refused and writes no second message', async () => {
    const inv = await plantArInvoice(pool);
    expect((await approveInvoice(inv.id)).state.statusCode).toBe(200);
    expect((await approveInvoice(inv.id)).state.statusCode).toBeGreaterThanOrEqual(400);
    expect(await messages(inv.id)).toHaveLength(1);
  });

  it('a date before the cut-over, and a connection with no cut-over, send nothing', async () => {
    const early = await plantArInvoice(pool, { date: '2025-12-31' });
    expect((await approveInvoice(early.id)).state.statusCode).toBe(200);
    expect(await messages(early.id)).toHaveLength(0);
    await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET cutover_date = NULL WHERE id = $1', [conn]), true);
    const later = await plantArInvoice(pool);
    expect((await approveInvoice(later.id)).state.statusCode).toBe(200);
    expect(await messages(later.id)).toHaveLength(0);
  });

  it('the cut-over day itself is mirrored', async () => {
    const onDay = await plantArInvoice(pool, { date: '2026-01-01' });
    expect((await approveInvoice(onDay.id)).state.statusCode).toBe(200);
    expect(await messages(onDay.id)).toHaveLength(1);
  });

  it('a revoked connection, an unlinked customer and an invoice for an ordinary customer send nothing', async () => {
    const other = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [other, co.A, 'IC ordinary customer']);
    const ordinary = await plantArInvoice(pool, { customer: other });
    expect((await approveInvoice(ordinary.id)).state.statusCode).toBe(200);
    expect(await messages(ordinary.id)).toHaveLength(0);

    await asAppUser(pool, U.a, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [conn]), true);
    const afterRevoke = await plantArInvoice(pool);
    expect((await approveInvoice(afterRevoke.id)).state.statusCode).toBe(200);
    expect(await messages(afterRevoke.id)).toHaveLength(0);
    expect(await gtx()).toHaveLength(0);
  });

  it('a foreign-currency invoice is still sent, with its currency, for the receiver to refuse', async () => {
    await enableFxDocuments(pool, co.A);
    const usd = await plantArInvoice(pool, { currency: 'USD', status: 'approved' });
    expect(await send(usd.id)).toMatchObject({ sent: true });
    expect((await messages(usd.id))[0].payload).toMatchObject({ currency: 'USD' });
  });

  it('a viewer\'s session writes no message: the database answers forbidden, the approval is told, and nothing is written', async () => {
    const inv = await plantArInvoice(pool, { status: 'approved' });
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const out = await asService(pool, U.va, co.A, () => mirrorApprovedInvoice(co.A, inv.id)); const calls = spy.mock.calls.slice(); spy.mockRestore();
    expect(out).toEqual({ sent: false, reason: 'forbidden' });
    expect(calls).toContainEqual([expect.stringMatching(/not sent/), expect.objectContaining({ kind: 'invoice', sourceId: inv.id, reason: 'forbidden' }), 'intercompany']);
    expect(await messages(inv.id)).toHaveLength(0);
    expect(await gtx()).toHaveLength(0);
  });

  it('a message the database refuses is logged AT ERROR (it is never re-sent: P5\'s reconciliation lists unsent documents) and never fails the caller', async () => {
    const inv = await plantArInvoice(pool, { status: 'approved' });
    // a database refusal at the INSERT (23514, as any of the messages guard's checks): a trigger that is there for this test only
    await pool.query(`CREATE FUNCTION public.zz_ic_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused' USING ERRCODE = '23514'; END $$`);
    await pool.query('CREATE TRIGGER zz_ic_refuse BEFORE INSERT ON intercompany_messages FOR EACH ROW EXECUTE FUNCTION public.zz_ic_refuse()');
    const spy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    let out: unknown; let calls: unknown[][] = [];
    try {
      out = await asService(pool, U.a, co.A, () => mirrorApprovedInvoice(co.A, inv.id)); calls = spy.mock.calls.slice();
    } finally {
      spy.mockRestore();
      await pool.query('DROP TRIGGER zz_ic_refuse ON intercompany_messages');
      await pool.query('DROP FUNCTION public.zz_ic_refuse()');
    }
    expect(out).toEqual({ sent: false, reason: 'failed' });
    expect(calls).toContainEqual([expect.stringMatching(/not sent/), expect.objectContaining({ kind: 'invoice', sourceId: inv.id, code: '23514' }), 'intercompany']);
    expect(await messages(inv.id)).toHaveLength(0);
    expect(await gtx()).toHaveLength(0);
  });

  it('an invoice that is not this company\'s has no connection for it, and sends nothing', async () => {
    const inv = await plantArInvoice(pool, { status: 'approved' });
    const out = await asService(pool, U.b, co.B, () => mirrorApprovedInvoice(co.B, inv.id));
    expect(out).toEqual({ sent: false, reason: 'no_connection' });
    expect(await messages(inv.id)).toHaveLength(0);
  });
});

describe('a document the receiver could not read is not sent, and says so at error', () => {
  it('a legacy invoice with a negative line (IsaFlow refuses these today; an import can hold one) is not sent: logged at error with the reason', async () => {
    const inv = await plantArInvoice(pool, { status: 'approved', lines: [['Credit-like line', 1, -100], ['Normal', 1, 600]] });
    const spy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const out = await asService(pool, U.a, co.A, () => mirrorApprovedInvoice(co.A, inv.id)); const calls = spy.mock.calls.slice(); spy.mockRestore();
    expect(out).toEqual({ sent: false, reason: 'unmirrorable' });
    expect(calls).toContainEqual([expect.stringMatching(/cannot be mirrored/), expect.objectContaining({ sourceId: inv.id }), 'intercompany']);
    expect(await messages(inv.id)).toHaveLength(0);
  });

  it('a 12-line invoice whose header VAT is the rate on the subtotal (R10.10 x 12 at 15%) is sent and its message can be read and accepted', async () => {
    const inv = await plantArInvoice(pool, { lines: Array.from({ length: 12 }, (_, i) => [`Line ${i + 1}`, 1, 10.1] as [string, number, number]) });
    expect((await approveInvoice(inv.id)).state.statusCode).toBe(200);
    const [m] = await messages(inv.id);
    expect(m.payload).toMatchObject({ subtotal: 121.2, taxAmount: 18.18, total: 139.38 });
    expect(m.payload.lines.reduce((t: number, l: { taxAmount: number }) => t + Math.round(l.taxAmount * 100), 0)).toBe(1818);
  });
});

describe('approving a customer credit note for a connected customer', () => {
  it('leaves one message with the exact VAT, and a negative group row; a retry writes no second', async () => {
    const id = await plantArCreditNote(pool);
    await asService(pool, U.a, co.A, () => approveCreditNote(co.A, id, U.a));
    const rows = await messages(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'credit_note', status: 'pending', source_doc_type: 'credit_note', to_company_id: co.B });
    expect(rows[0].payload).toMatchObject({ kind: 'credit_note', subtotal: 200, taxAmount: 30, total: 230, notes: 'Returned router' });
    const g = await gtx();
    expect(g).toHaveLength(1);
    expect(Number(g[0].amount)).toBe(-200);
    expect(await asService(pool, U.a, co.A, () => mirrorApprovedCreditNote(co.A, id))).toEqual({ sent: false, reason: 'already_sent' });
    expect(await messages(id)).toHaveLength(1);
  });

  it('a credit note dated before the cut-over, or for an unlinked customer, sends nothing', async () => {
    const early = await plantArCreditNote(pool, { date: '2025-06-01' });
    await asService(pool, U.a, co.A, () => approveCreditNote(co.A, early, U.a));
    expect(await messages(early)).toHaveLength(0);
    const other = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [other, co.A, 'IC other']);
    const unlinked = await plantArCreditNote(pool, { customer: other });
    await asService(pool, U.a, co.A, () => approveCreditNote(co.A, unlinked, U.a));
    expect(await messages(unlinked)).toHaveLength(0);
  });
});

describe('tenancy of the outbox', () => {
  it('a third company sees none of the messages, and B sees only its own', async () => {
    const inv = await plantArInvoice(pool);
    expect((await approveInvoice(inv.id)).state.statusCode).toBe(200);
    expect(await asAppUser(pool, U.c, co.C, async (q) => count(q, 'SELECT count(*) AS n FROM intercompany_messages'))).toBe(0);
    expect(await asAppUser(pool, U.c, co.C, async (q) => count(q, 'SELECT count(*) AS n FROM intercompany_transactions'))).toBe(0);
    expect(await asAppUser(pool, U.b, co.B, async (q) => count(q, 'SELECT count(*) AS n FROM intercompany_messages'))).toBe(1);
    expect(party.aCustomer).toBeTruthy();
  });
});
