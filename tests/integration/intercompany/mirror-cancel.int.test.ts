/**
 * Intercompany P2, the sender cancels a document it mirrored. A message the receiver has not handled is WITHDRAWN (not acceptable, never
 * auto-accepted, shown under Handled as "Cancelled by sender"); one the receiver already accepted is only FLAGGED (the receiver's draft and
 * data are never touched). The withdrawal acts for the session company only and only for a document that really is cancelled in its
 * books: through the real services, as app_user, across three tenants.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { approveSupplierInvoice } from '../../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { cancelCustomerInvoice } from '../../../src/modules/accounting/services/ar/customerInvoiceCancelService';
import { cancelCreditNote } from '../../../src/modules/accounting/services/ar/creditNoteCancelService';
import { mirrorApprovedCreditNote } from '../../../src/modules/accounting/services/intercompany/outboxService';
import { runAutoAccept } from '../../../src/modules/accounting/services/intercompany/autoAcceptWorker';
import { asAppUser, asDefiner, asOwner, outcome, withoutTrigger } from './intercompany.helpers';
import {
  asService, clearMirrorRows, co, connect, dataOf, errorOf, inbox, mirrorCleanup, mirrorSetup, plantArCreditNote, rawReverseJournal, sentInvoice, U, approveCreditNoteRow,
} from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(async () => { await clearMirrorRows(pool); await connect(pool); });

const row = async (id: string) => (await pool.query('SELECT * FROM intercompany_messages WHERE id = $1', [id])).rows[0];
const cancelInvoice = (id: string) => asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, id, U.a, { allowReversal: true }));
/**
 * A posted reversal of the invoice's journal written straight into the ledger (a statement, no service: the reversal service itself re-evaluates the
 * mirror, see mirror-crosstenant), then the status cancelled and the link cleared as a cancel does. The mirror has not been told.
 */
const rawReversal = async (inv: string, clearLink: boolean) => {
  const je = (await pool.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [inv])).rows[0].je as string;
  await rawReverseJournal(pool, je);
  await pool.query("UPDATE customer_invoices SET status = 'cancelled', gl_journal_entry_id = CASE WHEN $2 THEN NULL ELSE gl_journal_entry_id END WHERE id = $1", [inv, clearLink]);
};
const reverseOnly = (inv: string) => rawReversal(inv, true);
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
    await approveCreditNoteRow(pool, cn);
    await asService(pool, U.a, co.A, () => mirrorApprovedCreditNote(co.A, cn));
    const id = (await pool.query('SELECT id FROM intercompany_messages WHERE source_doc_id = $1', [cn])).rows[0].id as string;
    await asService(pool, U.a, co.A, () => cancelCreditNote(co.A, cn, U.a, 'issued in error'));
    expect(await row(id)).toMatchObject({ status: 'withdrawn' });
  });
});

describe('the group row a withdrawal releases is the one the DATABASE recorded (the second security scan, 1 and 2)', () => {
  const planted = (id: string, set: string, params: unknown[] = []) =>
    withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(`UPDATE intercompany_messages SET ${set} WHERE id = $1`, [id, ...params]));
  const rowOf = async (id: string) => (await pool.query('SELECT * FROM intercompany_transactions WHERE id = $1', [id])).rows[0];

  /** Sender invoice S1, accepted and approved by B (its row R1 is matched); and a second sent invoice S2 whose message the test then doctors. */
  async function pair() {
    const s1 = await sentInvoice(pool);
    expect((await inbox.accept(U.b, co.B, s1.id)).state.statusCode).toBe(200);
    const bill = (await row(s1.id)).target_doc_id as string;
    await asService(pool, U.b, co.B, () => approveSupplierInvoice(co.B, bill, U.b));
    const r1 = s1.message.payload.groupTransactionId as string;
    expect((await rowOf(r1)).match_status).toBe('matched');
    const s2 = await sentInvoice(pool);
    return { s1, s2, r1 };
  }

  it('a legacy message whose PAYLOAD names another of the sender\'s rows (and records none) releases nothing but its own cancel: the other row stays matched', async () => {
    const { s2, r1 } = await pair();
    await planted(s2.id, "payload = jsonb_set(payload, '{groupTransactionId}', to_jsonb($2::text)), group_transaction_id = NULL", [r1]);
    await cancelInvoice(s2.inv.id);
    expect(await row(s2.id)).toMatchObject({ status: 'withdrawn' });
    expect((await rowOf(r1)).match_status).toBe('matched');
  });

  it('even a row that passes every check for this message is not released on the payload\'s word: only the recorded reference is', async () => {
    const m = await sentInvoice(pool);
    const own = m.message.payload.groupTransactionId as string;
    // a second row of the same pair for the same journal (planted), matched; the payload is made to name it, the recorded reference stays the real one
    const twin = (await asDefiner(pool, U.a, co.A, (q) => q.query(
      `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, source_journal_entry_id, transaction_type, amount, currency, description, transaction_date, match_status)
       SELECT group_id, source_company_id, target_company_id, source_journal_entry_id, transaction_type, amount, currency, 'twin', transaction_date, 'variance' FROM intercompany_transactions WHERE id = $1 RETURNING id`, [own]), true)).rows[0].id as string;
    await planted(m.id, "payload = jsonb_set(payload, '{groupTransactionId}', to_jsonb($2::text))", [twin]);
    await cancelInvoice(m.inv.id);
    expect((await rowOf(own)).match_status).toBe('unmatched');
    expect((await rowOf(twin)).match_status).toBe('variance');
  });

  it('a recorded reference that is not this message\'s row (another journal) is not released either', async () => {
    const { s2, r1 } = await pair();
    await planted(s2.id, 'group_transaction_id = $2', [r1]);
    await cancelInvoice(s2.inv.id);
    expect(await row(s2.id)).toMatchObject({ status: 'withdrawn' });
    expect((await rowOf(r1)).match_status).toBe('matched');
    // and the honest case: the message\'s own row is released
    const own = await sentInvoice(pool);
    await cancelInvoice(own.inv.id);
    expect((await rowOf(own.message.payload.groupTransactionId)).match_status).toBe('unmatched');
  });

  it('the database records the journal and the row on the message it writes', async () => {
    const m = await sentInvoice(pool);
    const journal = (await pool.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [m.inv.id])).rows[0].je;
    expect(await row(m.id)).toMatchObject({ source_journal_entry_id: journal, group_transaction_id: m.message.payload.groupTransactionId });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_messages SET group_transaction_id = NULL WHERE id = $1', [m.id])).toMatch(/^42501/);   // no column grant
    });
    await asOwner(pool, U.b, co.B, async (q) => {   // and the guard itself (the table owner has every grant): handling a message never rewrites its record
      expect(await outcome(q, 'UPDATE intercompany_messages SET group_transaction_id = NULL WHERE id = $1', [m.id])).toMatch(/^23514: a message changes only its handling/);
      expect(await outcome(q, 'UPDATE intercompany_messages SET source_journal_entry_id = NULL WHERE id = $1', [m.id])).toMatch(/^23514: a message changes only its handling/);
    });
  });

  it('FAIL CLOSED: a message that records no journal proves nothing, so a cancelled, reversed document withdraws nothing', async () => {
    const m = await sentInvoice(pool);
    await planted(m.id, 'source_journal_entry_id = NULL');
    await reverseOnly(m.inv.id);
    const n = await asAppUser(pool, U.a, co.A, async (q) => Number((await q.query("SELECT public.intercompany_withdraw_for_source('customer_invoice', $1) AS n", [m.inv.id])).rows[0].n), true);
    expect(n).toBe(0);
    expect(await row(m.id)).toMatchObject({ status: 'pending', source_cancelled_at: null });
  });

  it('an invoice\'s link to its journal is cleared by the real cancel: a reversed journal with the link still set withdraws nothing, until the link is cleared', async () => {
    const m = await sentInvoice(pool);
    await rawReversal(m.inv.id, false);   // status cancelled, link NOT cleared
    const call = () => asAppUser(pool, U.a, co.A, async (q) => Number((await q.query("SELECT public.intercompany_withdraw_for_source('customer_invoice', $1) AS n", [m.inv.id])).rows[0].n), true);
    expect(await call()).toBe(0);
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE id = $1', [m.inv.id]);
    expect(await call()).toBe(1);
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
  it('only the sender\'s session, only for a document cancelled in its own books and reversed in its ledger; a stranger, the receiver and an uncancelled document change nothing', async () => {
    const live = await sentInvoice(pool);
    const call = (user: string, company: string, type: string, doc: string) =>
      asAppUser(pool, user, company, async (q) => Number((await q.query('SELECT public.intercompany_withdraw_for_source($1, $2) AS n', [type, doc])).rows[0].n), true);
    expect(await call(U.a, co.A, 'customer_invoice', live.inv.id)).toBe(0);              // not cancelled: no way to withdraw at will
    await reverseOnly(live.inv.id);
    expect(await call(U.b, co.B, 'customer_invoice', live.inv.id)).toBe(0);              // the receiver
    expect(await call(U.c, co.C, 'customer_invoice', live.inv.id)).toBe(0);              // a stranger
    expect(await call(U.ab, co.B, 'customer_invoice', live.inv.id)).toBe(0);             // a user of both, acting as B
    expect(await call(U.c, co.A, 'customer_invoice', live.inv.id)).toBe(0);             // a stranger who sets the company GUC to A: not a user of A
    expect(await call(U.va, co.A, 'customer_invoice', live.inv.id)).toBe(0);            // a viewer of the sender: no write role
    expect(await call(U.a, co.A, 'journal_entry', live.inv.id)).toBe(0);                 // another type
    expect((await row(live.id)).status).toBe('pending');
    expect(await call(U.a, co.A, 'customer_invoice', live.inv.id)).toBe(1);              // the sender, a cancelled document
    expect((await row(live.id)).status).toBe('withdrawn');
    expect(await call(U.a, co.A, 'customer_invoice', live.inv.id)).toBe(0);              // once
  });

  it('the status column is not the ledger: flipping an invoice to cancelled (the journal still stands) withdraws nothing, and flipping it back changes nothing (the breaker\'s P4)', async () => {
    const live = await sentInvoice(pool);
    const call = () => asAppUser(pool, U.a, co.A, async (q) => Number((await q.query("SELECT public.intercompany_withdraw_for_source('customer_invoice', $1) AS n", [live.inv.id])).rows[0].n), true);
    await pool.query("UPDATE customer_invoices SET status = 'cancelled' WHERE id = $1", [live.inv.id]);
    expect(await call()).toBe(0);
    expect(await row(live.id)).toMatchObject({ status: 'pending', source_cancelled_at: null });
    await pool.query("UPDATE customer_invoices SET status = 'approved' WHERE id = $1", [live.inv.id]);
    expect(await call()).toBe(0);
    expect(await row(live.id)).toMatchObject({ status: 'pending', source_cancelled_at: null });
    // the group row was never touched either
    expect((await pool.query('SELECT match_status FROM intercompany_transactions WHERE id = $1', [live.message.payload.groupTransactionId])).rows[0].match_status).toBe('unmatched');
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
