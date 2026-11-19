/**
 * Intercompany P2, the group's elimination feed (consolidatedReportingService.autoGenerateEliminations reads rows that are `matched`).
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
import { autoGenerateEliminations } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { mirrorApprovedCreditNote } from '../../../src/modules/accounting/services/intercompany/outboxService';
import { asAppUser } from './intercompany.helpers';
import {
  acc, asService, clearMirrorRows, co, connect, errorOf, inbox, mirrorCleanup, mirrorSetup, plantArCreditNote, sentInvoice, U,
} from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const ga = { rev: crypto.randomUUID(), exp: crypto.randomUUID() };

beforeAll(async () => {
  await mirrorSetup(pool);
  await pool.query(
    `INSERT INTO group_accounts(id, group_id, account_code, account_name, account_type) VALUES ($1, $3, 'G-REV', 'Group revenue', 'revenue'), ($2, $3, 'G-EXP', 'Group expense', 'expense')`,
    [ga.rev, ga.exp, co.G]);
  const aRev = (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'default_revenue'", [co.A])).rows[0].id;
  await pool.query('INSERT INTO group_coa_mappings(group_id, group_account_id, company_id, company_account_id) VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)',
    [co.G, ga.rev, co.A, aRev, ga.exp, co.B, acc.bExp1]);
}, 60000);
afterAll(async () => {
  await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]).catch(() => undefined);
  await pool.query('DELETE FROM group_coa_mappings WHERE group_id = $1', [co.G]).catch(() => undefined);
  await pool.query('DELETE FROM group_accounts WHERE group_id = $1', [co.G]).catch(() => undefined);
  await mirrorCleanup(pool);
}, 60000);
beforeEach(async () => {
  await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
  await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', [co.B]);
  await clearMirrorRows(pool);
  await connect(pool);
});

const groupRow = async () => (await pool.query('SELECT * FROM intercompany_transactions WHERE group_id = $1', [co.G])).rows[0];
const eliminate = () => autoGenerateEliminations(co.G, '2026-01-01', '2026-12-31');
const acceptBill = async () => {
  const { id } = await sentInvoice(pool);
  const res = await inbox.accept(U.b, co.B, id);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return (await pool.query("SELECT target_doc_id FROM intercompany_messages WHERE id = $1", [id])).rows[0].target_doc_id as string;
};

describe('an accepted DRAFT eliminates nothing; an APPROVED bill eliminates once, at the right amounts', () => {
  it('accept, leave the draft: the elimination generator yields 0; approve: 1, with the sender\'s revenue against the receiver\'s expense; cancel: back to 0', async () => {
    const bill = await acceptBill();
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', target_journal_entry_id: null });
    expect(await eliminate()).toHaveLength(0);

    await asService(pool, U.b, co.B, () => approveSupplierInvoice(co.B, bill, U.b));
    const matched = await groupRow();
    const journal = (await pool.query('SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = $1', [bill])).rows[0].gl_journal_entry_id;
    expect(journal).not.toBeNull();
    expect(matched).toMatchObject({ match_status: 'matched', matched_by: U.b, target_journal_entry_id: journal });
    expect(Number(matched.variance_amount)).toBe(0);
    const adjustments = await eliminate();
    expect(adjustments).toHaveLength(1);
    const lines = adjustments[0]!.lines as Array<{ groupAccountId: string; debit: number; credit: number }>;
    expect(lines.find((l) => l.groupAccountId === ga.rev)).toMatchObject({ debit: 1000, credit: 0 });
    expect(lines.find((l) => l.groupAccountId === ga.exp)).toMatchObject({ debit: 0, credit: 1000 });

    await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]);
    await asService(pool, U.b, co.B, () => cancelSupplierInvoice(co.B, bill, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched', matched_by: null, matched_at: null, target_journal_entry_id: null });
    expect(await eliminate()).toHaveLength(0);
  });

  it('a draft that is deleted stays unmatched and eliminates nothing', async () => {
    const bill = await acceptBill();
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [bill]);
    expect(await groupRow()).toMatchObject({ match_status: 'unmatched' });
    expect(await eliminate()).toHaveLength(0);
  });

  it('a bill the receiver changed before approving: matched as a VARIANCE with the difference, and eliminated for no amount', async () => {
    const bill = await acceptBill();
    // the receiver edits a line: R600 -> R500 (VAT follows), so its subtotal is R900 against the sender's R1 000
    await pool.query("UPDATE supplier_invoice_items SET unit_price = 250, line_total = 500, tax_amount = 75 WHERE supplier_invoice_id = $1 AND description = 'Fibre install'", [bill]);
    await pool.query('UPDATE supplier_invoices SET subtotal = 900, tax_amount = 135, total_amount = 1035 WHERE id = $1', [bill]);
    await asService(pool, U.b, co.B, () => approveSupplierInvoice(co.B, bill, U.b));
    expect(await groupRow()).toMatchObject({ match_status: 'variance' });
    expect(Number((await groupRow()).variance_amount)).toBe(100);
    expect(await eliminate()).toHaveLength(0);
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

describe('a supplier credit note', () => {
  it('matches when the receiver approves it (the sender\'s row is negative), and not before', async () => {
    const cn = await plantArCreditNote(pool);
    await pool.query("UPDATE credit_notes SET status = 'approved' WHERE id = $1", [cn]);
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
