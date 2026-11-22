/**
 * Intercompany P2, the group's elimination feed: a mirrored document's elimination is DERIVED from the two ledgers at read time (mirrorEliminations.ts).
 * Accepting a message creates a DRAFT, which books nothing in the receiver: eliminating the sender's revenue against an expense
 * that was never booked would be wrong. So the sender's `intercompany_transactions` row is matched only when the receiver's bill /
 * supplier credit note is APPROVED (target journal set, variance computed from the receiver's own subtotal), and goes back to
 * unmatched when that document is cancelled. Through the real services, as app_user, with the real elimination generator.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { approveSupplierInvoice, cancelSupplierInvoice } from '../../../src/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '../../../src/modules/accounting/services/ar/creditNoteApproveService';
import { getMirroredEliminations } from '../../../src/modules/accounting/services/reports/mirrorEliminations';
import { mirrorApprovedCreditNote } from '../../../src/modules/accounting/services/intercompany/outboxService';
import { asAppUser, outcome } from './intercompany.helpers';
import {
  asService, clearMirrorRows, co, connect, eliminationCleanup, eliminationSetup, errorOf, groupAccounts, inbox, mirrorCleanup, mirrorSetup, plantArCreditNote, sentInvoice, U, approveCreditNoteRow,
} from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const ga = groupAccounts;

beforeAll(async () => {
  await mirrorSetup(pool);
  await eliminationSetup(pool);
}, 60000);
afterAll(async () => {
  await eliminationCleanup(pool);
  await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
  await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', [co.B]);
  await clearMirrorRows(pool);
  await connect(pool);
});

const groupRow = async () => (await pool.query('SELECT * FROM intercompany_transactions WHERE group_id = $1', [co.G])).rows[0];
const derived = () => asService(pool, U.ab, co.A, () => getMirroredEliminations(co.G, "2026-01-01", "2026-12-31"));
const acceptBill = async () => {
  const { id } = await sentInvoice(pool);
  const res = await inbox.accept(U.b, co.B, id);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return (await pool.query("SELECT target_doc_id FROM intercompany_messages WHERE id = $1", [id])).rows[0].target_doc_id as string;
};

describe('an accepted DRAFT eliminates nothing; an APPROVED bill eliminates once, at the right amounts', () => {
  it('accept, leave the draft: the derived elimination is 0; approve: 1, with the sender\'s revenue against the receiver\'s expense; cancel: back to 0', async () => {
    const bill = await acceptBill();
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', target_journal_entry_id: null });
    expect(await derived()).toHaveLength(0);

    await asService(pool, U.b, co.B, () => approveSupplierInvoice(co.B, bill, U.b));
    const matched = await groupRow();
    const journal = (await pool.query('SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = $1', [bill])).rows[0].gl_journal_entry_id;
    expect(journal).not.toBeNull();
    expect(matched).toMatchObject({ match_status: 'matched', matched_by: U.b, target_journal_entry_id: journal });
    expect(Number(matched.variance_amount)).toBe(0);
    const derivedNow = await derived();
    expect(derivedNow).toHaveLength(1);
    expect(derivedNow[0]!.description).toMatch(/^Automatic: mirrored intercompany documents/);
    const lines = derivedNow[0]!.lines;
    expect(lines.find((l) => l.groupAccountId === ga.rev)).toMatchObject({ debit: 1000, credit: 0 });
    expect(lines.find((l) => l.groupAccountId === ga.exp)).toMatchObject({ debit: 0, credit: 1000 });
    expect((await pool.query('SELECT 1 FROM consolidation_adjustments WHERE group_id = $1', [co.G])).rowCount, 'nothing is stored').toBe(0);
    await asService(pool, U.b, co.B, () => cancelSupplierInvoice(co.B, bill, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', matched_by: null, matched_at: null, target_journal_entry_id: null });
    expect(await derived()).toHaveLength(0);
  });

  it('a draft that is deleted stays unmatched and eliminates nothing', async () => {
    const bill = await acceptBill();
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [bill]);
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect(await derived()).toHaveLength(0);
  });

  it('a bill the receiver changed before approving: matched as a VARIANCE with the difference, and eliminated for no amount', async () => {
    const bill = await acceptBill();
    // the receiver edits a line: R600 -> R500 (VAT follows), so its subtotal is R900 against the sender's R1 000
    await pool.query("UPDATE supplier_invoice_items SET unit_price = 250, line_total = 500, tax_amount = 75 WHERE supplier_invoice_id = $1 AND description = 'Fibre install'", [bill]);
    await pool.query('UPDATE supplier_invoices SET subtotal = 900, tax_amount = 135, total_amount = 1035 WHERE id = $1', [bill]);
    await asService(pool, U.b, co.B, () => approveSupplierInvoice(co.B, bill, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'variance' });
    expect(Number((await groupRow()).variance_amount)).toBe(100);
    expect(await derived()).toHaveLength(0);
  });

  it('the sync touches only the pair\'s own row: a third company\'s bill, and an unrelated bill of the receiver, change nothing', async () => {
    const bill = await acceptBill();
    const before = await groupRow();
    const other = (await pool.query(
      `INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, subtotal, tax_rate, tax_amount, total_amount, currency_code, status, created_by)
       SELECT $1, 'UNRELATED-1', supplier_id, DATE '2026-09-01', 10, 15, 1.5, 11.5, 'ZAR', 'draft', created_by FROM supplier_invoices WHERE id = $2 RETURNING id`, [co.B, bill])).rows[0].id;
    const returned = await asAppUser(pool, U.c, co.C, async (q) => (await q.query("SELECT public.intercompany_sync_group_row('supplier_invoice', $1) AS s", [bill])).rows[0].s);
    expect(returned).toBeNull(); // a stranger's session: nothing to do for it
    const unrelated = await asAppUser(pool, U.b, co.B, async (q) => (await q.query("SELECT public.intercompany_sync_group_row('supplier_invoice', $1) AS s", [other])).rows[0].s);
    expect(unrelated).toBeNull();
    expect(await groupRow()).toEqual(before);
  });
});

describe('the target journal is the definer\'s to set', () => {
  it('a writer of a party cannot set or clear target_journal_entry_id by an UPDATE of its own (999r\'s freeze holds), approved or not', async () => {
    const bill = await acceptBill();
    await asService(pool, U.b, co.B, () => approveSupplierInvoice(co.B, bill, U.b));
    const journal = (await pool.query('SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = $1', [bill])).rows[0].gl_journal_entry_id as string;
    const other = (await pool.query('SELECT id FROM gl_journal_entries WHERE company_id = $1 AND id <> $2 LIMIT 1', [co.A, journal])).rows[0]?.id as string | undefined;
    const tx = (await groupRow()).id as string;
    // a row that is NOT matched (a second sent invoice), and a journal of the target company: a target is the definer's to name, not a writer's
    const idle = await sentInvoice(pool);
    const idleRow = idle.message.payload.groupTransactionId as string;
    const bJournal = (await pool.query(
      `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES ('2026-09-01', 'planted', 'manual', 'posted', $1, $2) RETURNING id`, [U.ab, co.B])).rows[0].id as string;
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_transactions SET target_journal_entry_id = $2 WHERE id = $1', [idleRow, bJournal])).toMatch(/^23514: intercompany_transactions: a recorded transaction keeps/);
    });
    await asAppUser(pool, U.b, co.B, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_transactions SET target_journal_entry_id = NULL, match_status = \'unmatched\' WHERE id = $1', [tx])).toMatch(/^23514: intercompany_transactions: (a recorded transaction keeps|a row the mirror recorded)/);
    });
    expect(other, 'the sender\'s own approval journal, a journal of another company to point the row at').toBeDefined();
    await asAppUser(pool, U.ab, co.A, async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_transactions SET target_journal_entry_id = $2 WHERE id = $1', [tx, other])).toMatch(/^23514/);
    });
    expect((await groupRow()).target_journal_entry_id).toBe(journal);
  });
});

describe('a supplier credit note', () => {
  it('matches when the receiver approves it (the sender\'s row is negative), and not before', async () => {
    const cn = await plantArCreditNote(pool);
    await approveCreditNoteRow(pool, cn);
    await asService(pool, U.a, co.A, () => mirrorApprovedCreditNote(co.A, cn));
    const mid = (await pool.query('SELECT id FROM intercompany_messages WHERE source_doc_id = $1', [cn])).rows[0].id as string;
    const res = await inbox.accept(U.b, co.B, mid);
    expect(res.state.statusCode, errorOf(res)).toBe(200);
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    const note = (await pool.query("SELECT id FROM credit_notes WHERE company_id = $1 AND type = 'supplier'", [co.B])).rows[0].id as string;
    await asService(pool, U.b, co.B, () => approveCreditNote(co.B, note, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'matched', matched_by: U.b });
    expect(Number((await groupRow()).amount)).toBe(-200);
    expect(Number((await groupRow()).variance_amount)).toBe(0);
  });
});
