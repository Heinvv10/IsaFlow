/**
 * Intercompany P2, the sender's group row follows the LEDGERS, not the status columns (round 2 of the review). The row is `matched` (and so
 * eliminated) only while the sender's revenue stands AND the receiver's own posted journal is the expense for it:
 *  - the sender cancelling after the receiver approved un-matches the row and reverses the elimination generated from it; the other order
 *    (cancelled first, approved after) never matches it;
 *  - the receiver's journal must be posted, its own, the bill's, standing, in the fiscal period of the sender's date, for the connection's
 *    supplier, on expense accounts, and not another row's: any miss is a VARIANCE with its reason, never an elimination;
 *  - an elimination already generated survives nothing: unmatching reverses it, and generating twice (or at once) yields one per row;
 *  - a bill whose status and journal link a writer set by hand matches nothing; a viewer's sync writes nothing.
 * Through the real services as app_user across three tenants, with the real elimination generator.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { approveSupplierInvoice, cancelSupplierInvoice } from '../../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { reverseJournalEntry } from '../../../src/modules/accounting/services/gl/journalEntryService';
import { cancelCustomerInvoice } from '../../../src/modules/accounting/services/ar/customerInvoiceCancelService';
import { autoGenerateEliminations, postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { asAppUser, outcome, withoutTrigger } from './intercompany.helpers';
import {
  acc, asService, clearMirrorRows, co, connect, eliminationCleanup, eliminationSetup, inbox, mirrorCleanup, mirrorSetup, sentInvoice, U,
} from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const extra = { supplier: crypto.randomUUID(), asset: crypto.randomUUID() };

beforeAll(async () => {
  await mirrorSetup(pool);
  await eliminationSetup(pool);
  await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, $3)', [extra.supplier, co.B, 'IC B other supplier']);
  await pool.query(
    `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active)
     VALUES ($1, $2, $3, 'IC B fixed asset', 'asset', 'debit', true)`, [extra.asset, co.B, `ICFA${co.B.slice(0, 5)}`]);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, 'IC 2027', 1, 2027, '2027-01-01', '2027-12-31', 'open')`, [co.B]);
}, 60000);
afterAll(async () => {
  await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', [co.B]).catch(() => undefined);
  await pool.query("DELETE FROM fiscal_periods WHERE company_id = $1 AND period_name = 'IC 2027'", [co.B]).catch(() => undefined);
  await eliminationCleanup(pool);
  await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
  await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', [co.B]);
  await clearMirrorRows(pool);
  await connect(pool);
});

const rows = async () => (await pool.query('SELECT * FROM intercompany_transactions WHERE group_id = $1 ORDER BY created_at', [co.G])).rows;
const groupRow = async () => (await rows())[0];
const adjustments = async () => (await pool.query('SELECT id, status FROM consolidation_adjustments WHERE group_id = $1 ORDER BY created_at', [co.G])).rows as Array<{ id: string; status: string }>;
const eliminate = () => autoGenerateEliminations(co.G, '2026-01-01', '2026-12-31');
/** The sender's cancel in the LEDGER only (no hook): the approval journal reversed, the link cleared, the status cancelled. */
const senderReverse = (inv: string) => asService(pool, U.a, co.A, async (q) => {
  const je = (await q.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [inv])).rows[0].je as string;
  await reverseJournalEntry(co.A, je, U.a);
  await q.query("UPDATE customer_invoices SET status = 'cancelled', gl_journal_entry_id = NULL WHERE id = $1", [inv]);
});
const approveBill = (bill: string, user = U.b) => asService(pool, user, co.B, () => approveSupplierInvoice(co.B, bill, user));
const cancelSender = (inv: string) => asService(pool, U.a, co.A, () => cancelCustomerInvoice(co.A, inv, U.a));
const sync = (user: string, company: string, bill: string) =>
  asAppUser(pool, user, company, async (q) => (await q.query("SELECT public.intercompany_sync_group_row('supplier_invoice', $1) AS s", [bill])).rows[0].s as string | null, true);

/** A sent invoice, accepted by B: its message, the sender's invoice and B's draft bill. */
async function accepted(over: Parameters<typeof sentInvoice>[1] = {}) {
  const sent = await sentInvoice(pool, over);
  const res = await inbox.accept(U.b, co.B, sent.id);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  const bill = (await pool.query('SELECT target_doc_id FROM intercompany_messages WHERE id = $1', [sent.id])).rows[0].target_doc_id as string;
  return { ...sent, bill };
}

describe('the sender cancels AFTER the receiver approved (the reviewer\'s ledger A)', () => {
  it('the row leaves matched, its target journal is cleared, and the elimination already generated from it is reversed; generating again yields nothing', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });
    expect(await eliminate()).toHaveLength(1);
    expect(await adjustments()).toEqual([expect.objectContaining({ status: 'draft' })]);

    await cancelSender(m.inv.id);
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', matched_by: null, matched_at: null, target_journal_entry_id: null });
    expect(Number((await groupRow()).variance_amount)).toBe(0);
    expect(await adjustments()).toEqual([expect.objectContaining({ status: 'reversed' })]);
    expect(await eliminate()).toHaveLength(0);
    // the receiver's own bill is untouched (it is theirs): it stays approved, and its inbox row says the sender cancelled
    expect((await pool.query('SELECT status FROM supplier_invoices WHERE id = $1', [m.bill])).rows[0].status).toBe('approved');
    const handled = (inbox.list(U.b, co.B, { filter: 'handled' }));
    expect(((await handled).state.body as { data: { items: Array<{ sourceCancelled: boolean }> } }).data.items[0]).toMatchObject({ sourceCancelled: true });
  });

  it('an elimination already POSTED is reversed too (it no longer stands)', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const [made] = await eliminate();
    await postEliminationAdjustment(made!.id, co.G);
    expect(await adjustments()).toEqual([expect.objectContaining({ status: 'posted' })]);
    await cancelSender(m.inv.id);
    expect(await adjustments()).toEqual([expect.objectContaining({ status: 'reversed' })]);
  });

  it('the other order: cancelled (the message stamped) BEFORE the receiver approves, the approval never matches the row', async () => {
    const m = await accepted();
    await cancelSender(m.inv.id);
    expect((await pool.query('SELECT source_cancelled_at FROM intercompany_messages WHERE id = $1', [m.id])).rows[0].source_cancelled_at).not.toBeNull();
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', target_journal_entry_id: null });
    expect(await eliminate()).toHaveLength(0);
  });

  it('the sender\'s document cancelled in the LEDGER without the hook (its journal reversed): the receiver\'s approval does not match it', async () => {
    const m = await accepted();
    await senderReverse(m.inv.id);
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect(await eliminate()).toHaveLength(0);
  });

  it('a sender\'s status flipped by hand is not a cancel: the row stays matched (the ledger carries the revenue)', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    await pool.query("UPDATE customer_invoices SET status = 'cancelled' WHERE id = $1", [m.inv.id]);
    expect(await sync(U.b, co.B, m.bill)).toBe('matched');
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });
    expect(await eliminate()).toHaveLength(1);
  });
});

describe('a bill\'s status is not the ledger (the third security scan, 2)', () => {
  it('a bill flipped back to draft while its journal stands releases nothing: the row stays matched, its first journal and eliminations stand', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    await eliminate();
    const before = await groupRow();
    await pool.query("UPDATE supplier_invoices SET status = 'draft' WHERE id = $1", [m.bill]);
    expect(await sync(U.b, co.B, m.bill)).toBe('matched');
    expect(await groupRow()).toEqual(before);
    expect(before.first_target_journal_entry_id).toBe(before.target_journal_entry_id);
    expect(await adjustments()).toEqual([expect.objectContaining({ status: 'draft' })]);
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
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/fiscal period/) });
    expect(await eliminate()).toHaveLength(0);
  });

  it('a bill moved to another supplier: a variance, and no elimination', async () => {
    const m = await accepted();
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [m.bill, extra.supplier]);
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/supplier/) });
    expect(await eliminate()).toHaveLength(0);
  });

  it('a line re-coded to an ASSET account, the same subtotal: a variance, and no elimination (nothing was expensed)', async () => {
    const m = await accepted();
    await pool.query('UPDATE supplier_invoice_items SET gl_account_id = $2 WHERE supplier_invoice_id = $1', [m.bill, extra.asset]);
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/not expense/), target_journal_entry_id: null }); // a variance names no journal
    expect(await eliminate()).toHaveLength(0);
  });

  it('the honest case still matches: the bill as accepted, approved in the same period, for the connection\'s supplier', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'matched', variance_reason: null });
  });
});

describe('what a writer sets by hand proves nothing (the breaker\'s P3)', () => {
  it('a row that passes every check for the message is still not moved on the payload\'s word: only the recorded reference is', async () => {
    const m = await accepted();
    const own = m.message.payload.groupTransactionId as string;
    const twin = (await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, source_journal_entry_id, transaction_type, amount, currency, description, transaction_date)
       SELECT group_id, source_company_id, target_company_id, source_journal_entry_id, transaction_type, amount, currency, 'twin', transaction_date FROM intercompany_transactions WHERE id = $1 RETURNING id`, [own]))).rows[0].id as string;
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      "UPDATE intercompany_messages SET payload = jsonb_set(payload, '{groupTransactionId}', to_jsonb($2::text)) WHERE id = $1", [m.id, twin]));
    await approveBill(m.bill);
    const byId = Object.fromEntries((await rows()).map((r) => [r.id, r.match_status]));
    expect(byId[own]).toBe('matched');
    expect(byId[twin]).toBe('unmatched');
  });

  it('the row a sync moves is the one the DATABASE recorded for the message: a message whose recorded reference is another row moves nothing', async () => {
    const m = await accepted();
    const other = await sentInvoice(pool);
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      'UPDATE intercompany_messages SET group_transaction_id = $2 WHERE id = $1', [m.id, other.message.payload.groupTransactionId]));
    await approveBill(m.bill);
    expect((await rows()).map((r) => r.match_status)).toEqual(['unmatched', 'unmatched']);
    expect(await sync(U.b, co.B, m.bill)).toBeNull();
  });

  it('a draft bill flipped to approved with a journal of its own made up: not matched', async () => {
    const m = await accepted();
    await pool.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [m.bill]);
    expect(await sync(U.b, co.B, m.bill)).toBe('unmatched');   // approved but no journal
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
  });

  it('a bill pointed at ANOTHER bill\'s posted journal (the amount may even fit): a variance, and only the real row is eliminated', async () => {
    const real = await accepted();
    await approveBill(real.bill);
    const otherJournal = (await pool.query('SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = $1', [real.bill])).rows[0].je as string;
    const forged = await accepted();
    const forgedRow = forged.message.payload.groupTransactionId as string;
    await pool.query("UPDATE supplier_invoices SET status = 'approved', gl_journal_entry_id = $2 WHERE id = $1", [forged.bill, otherJournal]);
    expect(await sync(U.b, co.B, forged.bill)).toBe('variance');
    expect((await rows()).find((r) => r.id === forgedRow)).toMatchObject({ match_status: 'variance' });
    await eliminate();
    expect((await pool.query('SELECT source_intercompany_id AS s FROM consolidation_adjustments WHERE group_id = $1', [co.G])).rows.map((r) => r.s)).toEqual([real.message.payload.groupTransactionId]);
  });

  it('a bill pointed at a journal that is not a POSTED journal of its own company is a variance with that reason (draft clone; another company\'s clone)', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const num = (await pool.query('SELECT invoice_number AS n FROM supplier_invoices WHERE id = $1', [m.bill])).rows[0].n as string;
    const real = (await pool.query('SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = $1', [m.bill])).rows[0].je as string;
    const clone = async (company: string, status: string) => (await pool.query(
      `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ('2026-09-01', $1, 'auto_supplier_invoice', $2, $3, $4) RETURNING id`,
      [`Supplier invoice ${num}`, status, U.ab, company])).rows[0].id as string;
    const resync = async (je: string) => {
      await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
        "UPDATE intercompany_transactions SET match_status = 'unmatched', matched_at = NULL, matched_by = NULL, target_journal_entry_id = NULL WHERE group_id = $1", [co.G]));
      await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [m.bill, je]);
      expect(await sync(U.b, co.B, m.bill)).toBe('variance');
      return (await groupRow()).variance_reason as string;
    };
    expect(await resync(await clone(co.B, 'draft'))).toMatch(/not a posted journal of this company/);
    expect(await resync(await clone(co.A, 'posted'))).toMatch(/not a posted journal of this company/);
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [m.bill, real]);
  });

  it('a bill pointed at a standing posted journal that is NOT the one posting this document wrote (another bill\'s, free of any row) is a variance, not a match', async () => {
    const real = await accepted();
    await approveBill(real.bill);
    const stolen = (await groupRow()).target_journal_entry_id as string;
    const thief = await accepted();
    // the first row lets go of its journal (planted: only the definer clears a target), so nothing but the journal's own identity stands in the way
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      "UPDATE intercompany_transactions SET match_status = 'unmatched', matched_at = NULL, matched_by = NULL, target_journal_entry_id = NULL WHERE id = $1", [real.message.payload.groupTransactionId]));
    await pool.query("UPDATE supplier_invoices SET status = 'approved', gl_journal_entry_id = $2 WHERE id = $1", [thief.bill, stolen]);
    expect(await sync(U.b, co.B, thief.bill)).toBe('variance');
    expect((await rows()).find((r) => r.id === thief.message.payload.groupTransactionId)).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/posting this document wrote/) });
  });

  it('a journal whose TEXT is the bill\'s but which is another document\'s posting is not matched (the second security scan, 3)', async () => {
    const real = await accepted();
    await approveBill(real.bill);
    const realNumber = (await pool.query('SELECT invoice_number AS n FROM supplier_invoices WHERE id = $1', [real.bill])).rows[0].n as string;
    const posting = (await groupRow()).target_journal_entry_id as string;
    // the real bill is another supplier's now (it keeps its journal), and its row lets go of the journal (planted: only the definer clears a target)
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [real.bill, extra.supplier]);
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', (q) => q.query(
      "UPDATE intercompany_transactions SET match_status = 'unmatched', matched_at = NULL, matched_by = NULL, target_journal_entry_id = NULL WHERE id = $1", [real.message.payload.groupTransactionId]));
    // a second bill takes the first one's NUMBER (so the journal's description names it too) and its journal
    const copy = await accepted();
    await pool.query("UPDATE supplier_invoices SET invoice_number = $2, status = 'approved', gl_journal_entry_id = $3 WHERE id = $1", [copy.bill, realNumber, posting]);
    expect(await sync(U.b, co.B, copy.bill)).toBe('variance');
    expect((await rows()).find((r) => r.id === copy.message.payload.groupTransactionId)).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/posting of another document/) });
  });

  it('the first journal a row is matched to is the one it keeps: pointing the bill at a second journal of the same text and amount is a variance, and the row keeps its first', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const first = (await groupRow()).target_journal_entry_id as string;
    const j = (await pool.query('SELECT description, source, entry_date FROM gl_journal_entries WHERE id = $1', [first])).rows[0];
    const clone = (await pool.query(
      `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ($1, $2, $3, 'draft', $4, $5) RETURNING id`,
      [j.entry_date, j.description, j.source, U.ab, co.B])).rows[0].id as string;
    const apAccount = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'payable'", [co.B])).rows[0].id as string;
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 1000, 0, $4), ($1, $3, 0, 1000, $4)`, [clone, acc.bExp1, apAccount, co.B]);
    await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [clone]);
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [m.bill, clone]);
    expect(await sync(U.b, co.B, m.bill)).toBe('variance');
    expect(await groupRow()).toMatchObject({ match_status: 'variance', target_journal_entry_id: first, variance_reason: expect.stringMatching(/first matched/) });
  });

  it('a journal that is already another row\'s target is not matched to this one', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const journal = (await groupRow()).target_journal_entry_id as string;
    // a second row (planted with the immutability trigger off, as only the definer sets a target) claims the same journal
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_parties_immutable', async (q) => {
      await q.query(
        `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date, match_status, target_journal_entry_id)
         VALUES ($1, $2, $3, 'sale', 1000, 'ZAR', 'second claim', '2026-09-01', 'matched', $4)`, [co.G, co.A, co.B, journal]);
    });
    expect(await sync(U.b, co.B, m.bill)).toBe('variance');
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/already matched to another/) });
  });

  it('a REVERSED journal is not an expense: the bill\'s journal reversed by hand, the row does not stay matched', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const je = (await groupRow()).target_journal_entry_id as string;
    await pool.query("INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id, reversal_of_id, posted_at) SELECT entry_date, 'reversal', source, 'posted', created_by, company_id, id, now() FROM gl_journal_entries WHERE id = $1", [je]);
    const reversed = (await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = $1', [je])).rows[0].n;
    expect(reversed, 'the reversing journal was planted').toBe(1);
    expect(await sync(U.b, co.B, m.bill)).toBe('variance');
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/reversed/) });
  });
});

describe('the reason a row is a variance is the database\'s to write', () => {
  it('a writer of a party cannot write variance_reason (or clear it) by an UPDATE of its own', async () => {
    const m = await accepted();
    await pool.query("UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1", [m.bill, extra.supplier]);
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/supplier/) });
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_transactions SET variance_reason = 'all fine' WHERE group_id = $1", [co.G])).toMatch(/^23514: intercompany_transactions: the variance reason is written by the database/);
      expect(await outcome(q, 'UPDATE intercompany_transactions SET variance_reason = NULL WHERE group_id = $1', [co.G])).toMatch(/^23514/);
    });
    expect(await groupRow()).toMatchObject({ variance_reason: expect.stringMatching(/supplier/) });
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

describe('a row that stops being matched stops being eliminated', () => {
  it('matched, eliminated, then the receiver changes the supplier and the sync runs again: a variance, and the elimination is reversed', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await eliminate()).toHaveLength(1);
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [m.bill, extra.supplier]);
    expect(await sync(U.b, co.B, m.bill)).toBe('variance');
    expect(await adjustments()).toEqual([expect.objectContaining({ status: 'reversed' })]);
    expect(await eliminate()).toHaveLength(0);
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

describe('eliminations are idempotent per row and follow the row (the reviewer\'s ledger C)', () => {
  it('generating twice yields one adjustment; generating at the same moment yields one', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await eliminate()).toHaveLength(1);
    expect(await eliminate()).toHaveLength(0);
    expect(await adjustments()).toHaveLength(1);
    await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
    // two requests (each its own transaction, as a route runs it): the first has generated its elimination and not yet committed when the
    // second starts; the second waits on the first's row locks, then finds the elimination there and adds none
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let firstMade!: () => void;
    const made = new Promise<void>((resolve) => { firstMade = resolve; });
    const first = asService(pool, U.ab, co.A, async () => { const out = await eliminate(); firstMade(); await held; return out; });
    await made;
    const second = asService(pool, U.ab, co.A, () => eliminate());
    await new Promise((resolve) => setTimeout(resolve, 400)); // the second is waiting for the lock (without it, it has already written its own)
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.length, b.length]).toEqual([1, 0]);
    expect(await adjustments()).toHaveLength(1);
  });

  it('an unmatch (the receiver cancels its bill) reverses the elimination; a row matched again is eliminated again', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    await eliminate();
    await asService(pool, U.b, co.B, () => cancelSupplierInvoice(co.B, m.bill, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect(await adjustments()).toEqual([expect.objectContaining({ status: 'reversed' })]);
    // the receiver's bill is approved again through a fresh journal (the cancel cleared the link): the row is matched, and eliminated once more
    await pool.query("UPDATE supplier_invoices SET status = 'draft' WHERE id = $1", [m.bill]);
    await approveBill(m.bill);
    expect(await groupRow()).toMatchObject({ match_status: 'matched' });
    expect(await eliminate()).toHaveLength(1);
    expect((await adjustments()).map((a) => a.status).sort()).toEqual(['draft', 'reversed']);
  });
});

