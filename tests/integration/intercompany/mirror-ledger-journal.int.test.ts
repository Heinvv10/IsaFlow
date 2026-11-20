/**
 * Intercompany P2, what a writer sets by hand proves nothing: the receiver's bill status, its journal link, a journal of its own making with the
 * posting's text. Matching judges the journal's identity (own, original, named for the document, no other document's, not another row's) and
 * its VALUES (expense, input VAT and payable to the cent), and a row bound to its first journal is moved by that journal's fate alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cancelSupplierInvoice } from '../../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { postEliminationAdjustment } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { asAppUser, asDefiner, outcome, withoutTrigger } from './intercompany.helpers';
import { acc, asService, co, inbox, rawReverseJournal, sentInvoice, U } from './mirror.helpers';
import { reverseJournalEntry } from '../../../src/modules/accounting/services/gl/journalEntryService';
import { makeLedger } from './ledger.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { extra, rows, groupRow, adjustments, eliminate, approveBill, cancelSender, senderReverse, sync, accepted, unbind } = L;
beforeAll(L.setup, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

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
      await unbind();   // (a row bound to its first journal is moved by that journal alone: judge the new link afresh)
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

  it('a row bound to its FIRST journal is not moved by its bill: pointing the bill at a second journal (other amounts), moving its supplier or its status changes nothing while the first stands', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const before = await groupRow();
    const first = before.target_journal_entry_id as string;
    const j = (await pool.query('SELECT description, source, entry_date FROM gl_journal_entries WHERE id = $1', [first])).rows[0];
    const clone = (await pool.query(
      `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ($1, $2, $3, 'draft', $4, $5) RETURNING id`,
      [j.entry_date, j.description, j.source, U.ab, co.B])).rows[0].id as string;
    const apAccount = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'payable'", [co.B])).rows[0].id as string;
    await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 900, 0, $4), ($1, $3, 0, 900, $4)`, [clone, acc.bExp1, apAccount, co.B]);
    await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [clone]);
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = $2, supplier_id = $3 WHERE id = $1', [m.bill, clone, extra.supplier]);
    expect(await sync(U.b, co.B, m.bill)).toBe('matched');
    expect(await groupRow()).toEqual(before);
    expect(await eliminate()).toHaveLength(1);
  });

  it('B4: a journal a writer posted with the bill\'s posting text and the right expense but no VAT and a short payable is a variance (the sender\'s figures are judged by value)', async () => {
    const m = await accepted();
    const num = (await pool.query('SELECT invoice_number AS n FROM supplier_invoices WHERE id = $1', [m.bill])).rows[0].n as string;
    const ap = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'payable'", [co.B])).rows[0].id as string;
    await asAppUser(pool, U.b, co.B, async (q) => {
      const je = (await q.query(
        `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ('2026-09-01', $1, 'auto_supplier_invoice', 'draft', $2, $3) RETURNING id`,
        [`Supplier invoice ${num}`, U.b, co.B])).rows[0].id as string;
      await q.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id) VALUES ($1, $2, 1000, 0, $4), ($1, $3, 0, 1000, $4)', [je, acc.bExp1, ap, co.B]);
      await q.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [je]);
      await q.query("UPDATE supplier_invoices SET status = 'approved', gl_journal_entry_id = $2 WHERE id = $1", [m.bill, je]);
    }, true);
    expect(await sync(U.b, co.B, m.bill)).toBe('variance');
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/input VAT or payable is not the sender's VAT and total/) });
    expect(await eliminate()).toHaveLength(0);
  });

  it('a journal that is already another row\'s target is not matched to this one', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const journal = (await groupRow()).target_journal_entry_id as string;
    await unbind();   // judge the bill afresh against a second claim on its journal
    // a second row (planted with the immutability trigger off, as only the definer sets a target) claims the same journal
    await asDefiner(pool, U.a, co.A, async (q) => {
      await q.query(
        `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date, match_status, target_journal_entry_id)
         VALUES ($1, $2, $3, 'sale', 1000, 'ZAR', 'second claim', '2026-09-01', 'matched', $4)`, [co.G, co.A, co.B, journal]);
    }, true);
    expect(await sync(U.b, co.B, m.bill)).toBe('variance');
    expect(await groupRow()).toMatchObject({ match_status: 'variance', variance_reason: expect.stringMatching(/already matched to another/) });
  });

  it('a REVERSED journal is not an expense: the bill\'s journal reversed by hand, the row does not stay matched', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const je = (await groupRow()).target_journal_entry_id as string;
    await rawReverseJournal(pool, je, 'reversal');
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


describe('a row that stops being matched stops being eliminated', () => {
  it('a DIRECT reversal of the bill\'s journal (no cancel, no hook of the bill): the row is released, the elimination reversed with when and why', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    expect(await eliminate()).toHaveLength(1);
    const je = (await groupRow()).target_journal_entry_id as string;
    await asService(pool, U.b, co.B, () => reverseJournalEntry(co.B, je, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', target_journal_entry_id: null, first_target_journal_entry_id: je });
    const [a] = await adjustments();
    expect(a).toMatchObject({ status: 'reversed', reversed_reason: expect.stringMatching(/receiver's journal was reversed/) });
    expect(a!.reversed_at).not.toBeNull();
    expect(await eliminate()).toHaveLength(0);
  });
});
