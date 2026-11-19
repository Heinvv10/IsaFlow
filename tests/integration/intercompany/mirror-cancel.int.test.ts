/**
 * Intercompany P2, the sender cancels a document it mirrored. A message the receiver has not handled is WITHDRAWN (not acceptable, never
 * auto-accepted, shown under Handled as "Cancelled by sender"); one the receiver already accepted is only FLAGGED (the receiver's draft and
 * data are never touched). The withdrawal acts for the session company only and only for a document that really is cancelled in its
 * books: through the real services, as app_user, across three tenants.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cancelCustomerInvoice } from '../../../src/modules/accounting/services/ar/customerInvoiceCancelService';
import { cancelCreditNote } from '../../../src/modules/accounting/services/ar/creditNoteCancelService';
import { mirrorApprovedCreditNote } from '../../../src/modules/accounting/services/intercompany/outboxService';
import { runAutoAccept } from '../../../src/modules/accounting/services/intercompany/autoAcceptWorker';
import { asAppUser, outcome } from './intercompany.helpers';
import {
  asService, clearMirrorRows, co, connect, dataOf, errorOf, inbox, mirrorCleanup, mirrorSetup, plantArCreditNote, sentInvoice, U,
} from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(async () => { await clearMirrorRows(pool); await connect(pool); });

const row = async (id: string) => (await pool.query('SELECT * FROM intercompany_messages WHERE id = $1', [id])).rows[0];
const cancelInvoice = (id: string) => asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, id, U.a));
const bills = async () => (await pool.query('SELECT * FROM supplier_invoices WHERE company_id = $1', [co.B])).rows;

describe('a message the receiver has not handled', () => {
  it('is withdrawn when the sender cancels the invoice: not acceptable, not counted, listed as Cancelled by sender', async () => {
    const { inv, id } = await sentInvoice(pool);
    expect(dataOf<{ openCount: number }>(await inbox.count(U.b, co.B)).openCount).toBe(1);
    await cancelInvoice(inv.id);
    expect(await row(id)).toMatchObject({ status: 'withdrawn' });
    expect((await row(id)).source_cancelled_at).not.toBeNull();
    expect(dataOf<{ openCount: number }>(await inbox.count(U.b, co.B)).openCount).toBe(0);
    const handled = dataOf<{ items: Array<{ id: string; status: string; sourceCancelled: boolean }> }>(await inbox.list(U.b, co.B, { filter: 'handled' }));
    expect(handled.items.map((i) => [i.id, i.status, i.sourceCancelled])).toEqual([[id, 'withdrawn', true]]);
    const res = await inbox.accept(U.b, co.B, id);
    expect(res.state.statusCode).toBe(409);
    expect(errorOf(res)).toMatch(/sender cancelled/);
    expect(await bills()).toHaveLength(0);
    expect((await inbox.reject(U.b, co.B, id, { reason: 'x' })).state.statusCode).toBe(409);
    expect((await inbox.dismiss(U.b, co.B, id)).state.statusCode).toBe(409);
    const preview = dataOf<{ blockers: string[] }>(await inbox.get(U.b, co.B, id));
    expect(preview.blockers.join(' ')).toMatch(/sender cancelled/);
  });

  it('a dismissed message is withdrawn too; a rejected one is left as it is', async () => {
    const dismissed = await sentInvoice(pool);
    const rejected = await sentInvoice(pool);
    expect((await inbox.dismiss(U.b, co.B, dismissed.id)).state.statusCode).toBe(200);
    expect((await inbox.reject(U.b, co.B, rejected.id, { reason: 'not ours' })).state.statusCode).toBe(200);
    await cancelInvoice(dismissed.inv.id);
    await cancelInvoice(rejected.inv.id);
    expect(await row(dismissed.id)).toMatchObject({ status: 'withdrawn' });
    expect(await row(rejected.id)).toMatchObject({ status: 'rejected', source_cancelled_at: null });
  });

  it('is never taken by the auto-accept worker once withdrawn', async () => {
    await clearMirrorRows(pool);
    await connect(pool, { autoAccept: true });
    const { inv, id } = await sentInvoice(pool);
    await cancelInvoice(inv.id);
    expect(await runAutoAccept()).toMatchObject({ considered: 0, accepted: 0 });
    expect(await row(id)).toMatchObject({ status: 'withdrawn' });
    expect(await bills()).toHaveLength(0);
  });

  it('a customer credit note the sender cancels is withdrawn the same way', async () => {
    const cn = await plantArCreditNote(pool);
    await pool.query("UPDATE credit_notes SET status = 'approved' WHERE id = $1", [cn]);
    await asService(pool, U.a, co.A, () => mirrorApprovedCreditNote(co.A, cn));
    const id = (await pool.query('SELECT id FROM intercompany_messages WHERE source_doc_id = $1', [cn])).rows[0].id as string;
    await asService(pool, U.a, co.A, () => cancelCreditNote(co.A, cn, U.a, 'issued in error'));
    expect(await row(id)).toMatchObject({ status: 'withdrawn' });
  });
});

describe('a message the receiver already accepted', () => {
  it('stays accepted and is FLAGGED; the receiver\'s draft is not touched, deleted or changed', async () => {
    const { inv, id } = await sentInvoice(pool);
    expect((await inbox.accept(U.b, co.B, id)).state.statusCode).toBe(200);
    const [before] = await bills();
    const itemsBefore = (await pool.query('SELECT * FROM supplier_invoice_items WHERE supplier_invoice_id = $1 ORDER BY description', [before.id])).rows;
    await cancelInvoice(inv.id);
    expect(await row(id)).toMatchObject({ status: 'accepted', target_doc_id: before.id });
    expect((await row(id)).source_cancelled_at).not.toBeNull();
    const [after] = await bills();
    expect(after).toEqual(before);
    expect((await pool.query('SELECT * FROM supplier_invoice_items WHERE supplier_invoice_id = $1 ORDER BY description', [before.id])).rows).toEqual(itemsBefore);
    const handled = dataOf<{ items: Array<{ id: string; status: string; sourceCancelled: boolean }> }>(await inbox.list(U.b, co.B, { filter: 'handled' }));
    expect(handled.items[0]).toMatchObject({ id, status: 'accepted', sourceCancelled: true });
  });
});

describe('who can withdraw', () => {
  it('only the sender\'s session, only for a document cancelled in its own books; a stranger, the receiver and an uncancelled document change nothing', async () => {
    const live = await sentInvoice(pool);
    const call = (user: string, company: string, type: string, doc: string) =>
      asAppUser(pool, user, company, async (q) => Number((await q.query('SELECT public.intercompany_withdraw_for_source($1, $2) AS n', [type, doc])).rows[0].n), true);
    expect(await call(U.a, co.A, 'customer_invoice', live.inv.id)).toBe(0);              // not cancelled: no way to withdraw at will
    await pool.query("UPDATE customer_invoices SET status = 'cancelled' WHERE id = $1", [live.inv.id]);
    expect(await call(U.b, co.B, 'customer_invoice', live.inv.id)).toBe(0);              // the receiver
    expect(await call(U.c, co.C, 'customer_invoice', live.inv.id)).toBe(0);              // a stranger
    expect(await call(U.ab, co.B, 'customer_invoice', live.inv.id)).toBe(0);             // a user of both, acting as B
    expect(await call(U.c, co.A, 'customer_invoice', live.inv.id)).toBe(0);             // a stranger who sets the company GUC to A: not a user of A
    expect(await call(U.a, co.A, 'journal_entry', live.inv.id)).toBe(0);                 // another type
    expect((await row(live.id)).status).toBe('pending');
    expect(await call(U.a, co.A, 'customer_invoice', live.inv.id)).toBe(1);              // the sender, a cancelled document
    expect((await row(live.id)).status).toBe('withdrawn');
    expect(await call(U.a, co.A, 'customer_invoice', live.inv.id)).toBe(0);              // once
  });

  it('no session can withdraw, stamp or reopen a message by an UPDATE of its own', async () => {
    const m = await sentInvoice(pool);
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_messages SET status = 'withdrawn' WHERE id = $1", [m.id])).toMatch(/^23514/);
      expect(await outcome(q, 'UPDATE intercompany_messages SET source_cancelled_at = now() WHERE id = $1', [m.id])).toMatch(/^42501/);
    });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect((await q.query("UPDATE intercompany_messages SET status = 'withdrawn' WHERE id = $1", [m.id])).rowCount).toBe(0);
    }, true);
    expect((await row(m.id)).status).toBe('pending');
  });
});
