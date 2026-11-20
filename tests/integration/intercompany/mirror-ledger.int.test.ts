/**
 * Intercompany P2, the sender's group row follows the LEDGERS, not the status columns. The row is `matched` (and so eliminated) only while the
 * sender's revenue stands AND the receiver's own posted journal is the expense for it: the sender cancelling after the receiver approved
 * un-matches the row and reverses the elimination generated from it (the other order never matches it); a bill's status or a sender's status
 * flipped by hand is not a cancel; any miss in the receiver's journal is a VARIANCE with its reason; eliminations are one per row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cancelSupplierInvoice } from '../../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { asAppUser, outcome, withoutTrigger } from './intercompany.helpers';
import { asService, co, inbox, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { extra, rows, groupRow, adjustments, derived, approveBill, cancelSender, senderReverse, sync, accepted, unbind } = L;
beforeAll(L.setup, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

describe('the sender cancels AFTER the receiver approved (the reviewer\'s ledger A)', () => {
  it('the row leaves matched, its target journal is cleared, and the elimination already generated from it is reversed; generating again yields nothing', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });
    expect(await derived()).toHaveLength(1);

    await cancelSender(m.inv.id);
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', matched_by: null, matched_at: null, target_journal_entry_id: null });
    expect(Number((await groupRow()).variance_amount)).toBe(0);
    expect(await derived()).toHaveLength(0);
    // the receiver's own bill is untouched (it is theirs): it stays approved, and its inbox row says the sender cancelled
    expect((await pool.query('SELECT status FROM supplier_invoices WHERE id = $1', [m.bill])).rows[0].status).toBe('approved');
    const handled = (inbox.list(U.b, co.B, { filter: 'handled' }));
    expect(((await handled).state.body as { data: { items: Array<{ sourceCancelled: boolean }> } }).data.items[0]).toMatchObject({ sourceCancelled: true });
  });

  it('the derived elimination (what the reports read) is there while the ledgers carry it and gone once the sender cancels; nothing is stored either way', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await derived()).toHaveLength(1);
    await cancelSender(m.inv.id);
    expect(await derived()).toHaveLength(0);
    expect(await adjustments()).toHaveLength(0);
  });

  it('the other order: cancelled (the message stamped) BEFORE the receiver approves, the approval never matches the row', async () => {
    const m = await accepted();
    await cancelSender(m.inv.id);
    expect((await pool.query('SELECT source_cancelled_at FROM intercompany_messages WHERE id = $1', [m.id])).rows[0].source_cancelled_at).not.toBeNull();
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', target_journal_entry_id: null });
    expect(await derived()).toHaveLength(0);
  });

  it('the sender\'s document cancelled in the LEDGER without the hook (its journal reversed): the receiver\'s approval does not match it', async () => {
    const m = await accepted();
    await senderReverse(m.inv.id);
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect(await derived()).toHaveLength(0);
  });

  it('a sender\'s status flipped by hand is not a cancel: the row stays matched (the ledger carries the revenue)', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    await pool.query("UPDATE customer_invoices SET status = 'cancelled' WHERE id = $1", [m.inv.id]);
    expect(await sync(U.b, co.B, m.bill)).toBe('matched');
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });
    expect(await derived()).toHaveLength(1);
  });
});

describe('a bill\'s status is not the ledger (the third security scan, 2)', () => {
  it('a bill flipped back to draft while its journal stands releases nothing: the row stays matched, its first journal and eliminations stand', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const before = await groupRow();
    await pool.query("UPDATE supplier_invoices SET status = 'draft' WHERE id = $1", [m.bill]);
    expect(await sync(U.b, co.B, m.bill)).toBe('matched');
    expect(await groupRow()).toEqual(before);
    expect(before.first_target_journal_entry_id).toBe(before.target_journal_entry_id);
    expect(await derived()).toHaveLength(1);
  });

  it('a real cancel (the journal reversed) releases the row but keeps the first journal; no request can clear or set it', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const first = (await groupRow()).target_journal_entry_id as string;
    await asService(pool, U.b, co.B, () => cancelSupplierInvoice(co.B, m.bill, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', target_journal_entry_id: null, first_target_journal_entry_id: first });
    const tx = (await groupRow()).id as string;
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_transactions SET first_target_journal_entry_id = NULL WHERE id = $1', [tx])).toMatch(/^23514: intercompany_transactions: the first matched journal/);
    });
    const reversal = (await pool.query('SELECT id FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id = $2', [co.B, first])).rows[0].id as string;
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_transactions SET first_target_journal_entry_id = $2 WHERE id = $1', [tx, reversal])).toMatch(/^23514: intercompany_transactions: the first matched journal/);
    });
    await asAppUser(pool, U.ab, co.A, async (q) => {
      expect(await outcome(q, `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date, first_target_journal_entry_id)
        VALUES ($1, $2, $3, 'sale', 5, 'ZAR', 'forged', '2026-09-01', $4)`, [co.G, co.A, co.B, first])).toMatch(/^23514: intercompany_transactions: a new transaction is unmatched/);
    });
  });
});


describe('the receiver\'s journal must be the expense for it (the reviewer\'s ledger B)', () => {
  it('a bill re-dated into another fiscal period: a variance, with the reason, and no elimination', async () => {
    const m = await accepted();
    await pool.query("UPDATE supplier_invoices SET invoice_date = '2027-01-05' WHERE id = $1", [m.bill]);
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/financial years/) });
    expect(await derived()).toHaveLength(0);
  });

  it('a bill moved to another supplier: a variance, and no elimination', async () => {
    const m = await accepted();
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [m.bill, extra.supplier]);
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/supplier/) });
    expect(await derived()).toHaveLength(0);
  });

  it('a line re-coded to an ASSET account, the same subtotal: a variance, and no elimination (nothing was expensed)', async () => {
    const m = await accepted();
    await pool.query('UPDATE supplier_invoice_items SET gl_account_id = $2 WHERE supplier_invoice_id = $1', [m.bill, extra.asset]);
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/not expense/), target_journal_entry_id: null }); // a variance names no journal
    expect(await derived()).toHaveLength(0);
  });

  it('the honest case still matches: the bill as accepted, approved in the same period, for the connection\'s supplier', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'matched', variance_reason: null });
  });
});


describe('a viewer\'s sync writes nothing (the breaker\'s P9)', () => {
  it('a viewer of the receiver cannot re-sign the matched row, nor unmatch it, by calling the definer', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const before = await groupRow();
    expect(before.matched_by).toBe(U.b);
    expect(await sync(U.avb, co.B, m.bill)).toBeNull();          // owner of A, VIEWER of B
    await pool.query("UPDATE supplier_invoices SET status = 'draft' WHERE id = $1", [m.bill]);
    expect(await sync(U.avb, co.B, m.bill)).toBeNull();
    expect(await groupRow()).toEqual(before);
  });
});


describe('the receiver approves a bill that already carried a journal (the reviewer\'s ledger D)', () => {
  it('a DRAFT that holds its posted journal (legacy "Post to GL" then approve: approve reuses the journal, the early-return branch): the row matches', async () => {
    const m = await accepted();
    await approveBill(m.bill);                 // posts the journal ...
    // ... and the bill goes back to a draft that still carries it (what "Post to GL" on a draft used to leave); the row is as it was before the approval
    await pool.query("UPDATE supplier_invoices SET status = 'draft' WHERE id = $1", [m.bill]);
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      "UPDATE intercompany_transactions SET match_status = 'unmatched', matched_at = NULL, matched_by = NULL, target_journal_entry_id = NULL WHERE group_id = $1", [co.G]));
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', target_journal_entry_id: null });
    await approveBill(m.bill);
    expect((await pool.query('SELECT status FROM supplier_invoices WHERE id = $1', [m.bill])).rows[0].status).toBe('approved');
    expect(await groupRow()).toMatchObject({ match_status: 'matched', matched_by: U.b });
  });
});

describe('derived eliminations follow the ledgers (the reviewer\'s ledger C)', () => {
  it('reading twice (or at the same moment) yields the same figures and writes nothing: there is no generator to race', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const [a, b, c] = await Promise.all([derived(), derived(), derived()]);
    expect([a.length, b.length, c.length]).toEqual([1, 1, 1]);
    expect(b).toEqual(a);
    expect(await adjustments()).toHaveLength(0);
  });

  it('an unmatch (the receiver cancels its bill) removes the elimination; a bill approved again through a fresh journal brings it back', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await derived()).toHaveLength(1);
    await asService(pool, U.b, co.B, () => cancelSupplierInvoice(co.B, m.bill, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect(await derived()).toHaveLength(0);
    // the receiver's bill is approved again through a fresh journal (the cancel cleared the link): the row is matched, and eliminated once more
    await pool.query("UPDATE supplier_invoices SET status = 'draft' WHERE id = $1", [m.bill]);
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });
    expect(await derived()).toHaveLength(1);
  });
});
