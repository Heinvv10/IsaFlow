/**
 * document_vat_history (brief step 5a) against a real schema: a bill posted with VAT, a hand-made journal
 * that names it and reverses its input VAT (the SIV3762 / JE-2026-26788 shape), and a linked credit note
 * — the totals, the ties, and the heuristic's precision (whole token, VAT-bearing journals only, this
 * company only). Driven through the MCP tool's handler.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice, cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { documentVatHistoryTool } from '@/lib/mcp/tools/documentVatHistory';
import type { McpToolContext } from '@/lib/mcp/types';
import type { DocumentVatHistory } from '@/modules/accounting/services/reports/documentVatHistory';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropFixture, inTx, seedFixture, seedInvoice, seedSupplier, type Fixture } from './helpers/l1FifoFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let other: Fixture;
let seq = 0;
const acct: Record<string, string> = {};

const idOf = async (f: Fixture, subtype: string) => String(((await sql`
  SELECT id FROM gl_accounts WHERE company_id = ${f.companyId}::UUID AND account_subtype = ${subtype}`) as Row[])[0]!.id);
const number = () => `SIV${String(Date.now()).slice(-6)}${++seq}`;

async function bill(invoiceNumber: string, amount: number): Promise<string> {
  const s = await seedSupplier(fx, `dvh-${seq}`);
  const created = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId: s, invoiceNumber, invoiceDate: '2026-06-01',
    items: [{ description: 'Line', quantity: 1, unitPrice: amount, glAccountId: acct.cos! }],
  }, fx.userId));
  await inTx(fx, () => approveSupplierInvoice(fx.companyId, created.id, fx.userId));
  return created.id;
}

async function journal(f: Fixture, head: { description: string; reference?: string }, lines: JournalLineInput[]): Promise<string> {
  return inTx(f, async () => {
    const je = await createJournalEntry(f.companyId, { entryDate: '2026-06-15', source: 'manual', ...head, lines }, f.userId);
    await postJournalEntry(f.companyId, je.id, f.userId);
    return je.id;
  });
}
/** DR the expense, CR input VAT: a hand-made reversal of a bill's input VAT (JE-2026-26788). */
const vatOut = (f: Fixture, vatInput: string, expense: string, amount: number, head: { description: string; reference?: string }) =>
  journal(f, head, [
    { glAccountId: expense, debit: amount, credit: 0, description: head.description },
    { glAccountId: vatInput, debit: 0, credit: amount, description: head.description, vatType: 'standard' },
  ]);

async function history(entityType: string, entityId: string, f: Fixture = fx): Promise<DocumentVatHistory> {
  const ctx = { companyId: f.companyId, userId: f.userId, scopes: ['read:vat', 'read:invoices'], tokenJti: 'j' } as unknown as McpToolContext;
  const r = await documentVatHistoryTool.handler({ entity_type: entityType, entity_id: entityId }, ctx);
  expect(r.isError, r.content[0]!.text).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as DocumentVatHistory;
}

async function supplierNote(billId: string, subtotal: number): Promise<{ id: string; number: string }> {
  const supplierId = String(((await sql`SELECT supplier_id FROM supplier_invoices WHERE id = ${billId}::UUID`) as Row[])[0]!.supplier_id);
  const note = await inTx(fx, () => createCreditNote(fx.companyId, {
    type: 'supplier', supplierId, supplierInvoiceId: billId, creditDate: '2026-06-20', subtotal,
  }, fx.userId));
  await inTx(fx, () => approveCreditNote(fx.companyId, note.id, fx.userId));
  return { id: note.id, number: note.creditNoteNumber };
}

describeIfDisposable('document_vat_history — every VAT line tied to a document', () => {
  beforeAll(async () => {
    fx = await seedFixture('dvh', process.env.DATABASE_URL!);
    other = await seedFixture('dvh-other', process.env.DATABASE_URL!);
    acct.cos = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '5010', ${`COS ${fx.tag}`}, 'expense', 'debit', true) RETURNING id`) as Row[])[0]!.id);
    acct.vatIn = await idOf(fx, 'vat_input');
    acct.vatOut = await idOf(fx, 'vat_output');
    acct.ar = await idOf(fx, 'receivable');
    acct.revenue = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '4000', ${`Sales ${fx.tag}`}, 'revenue', 'credit', true) RETURNING id`) as Row[])[0]!.id);
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      if (!f) continue;
      const c = f.companyId;
      await sql`DELETE FROM credit_note_expense_allocations WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM credit_notes WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM company_document_numbers WHERE company_id = ${c}::UUID`;
      await dropFixture(f);
    }
  }, 120000);

  it('bill + a hand-made VAT reversal naming it + a linked credit note: the ties and the totals', async () => {
    const num = number();
    const b = await bill(num, 1000);
    const manual = await vatOut(fx, acct.vatIn!, acct.cos!, 150, { description: `Slip review: reverse input VAT on ${num}` });
    const cn = await supplierNote(b, 400);

    const h = await history('supplier_invoice', b);
    expect(h.lines.map((l) => [l.tie, l.vat_amount, l.net_base])).toEqual([
      ['posting', 150, 1000], ['credit_note', -60, -400], ['narration_match', -150, null],
    ]);
    const m = h.lines.find((l) => l.tie === 'narration_match')!;
    expect(m).toMatchObject({ journal_entry_id: manual, matched_in: 'narration,line_narration', source: 'manual', status: 'posted', reversed: false });
    expect(h.lines.find((l) => l.tie === 'credit_note')!.tied_via).toBe(cn.number);
    expect(h.totals).toEqual({
      vat_posted: 150, vat_reversed: 210, vat_net_now: -60, vat_derivable_now: 90, vat_heuristic: -150,
      vat_by_tie: { posting: 150, late_claim: 0, reversal: 0, credit_note: -60, reference_match: 0, narration_match: -150 },
      net_base_posted: 1000, net_base_now: 600,
    });
    expect(h.heuristic).toMatchObject({ tokens: [num], journals_matched: 1, truncated: false });
  });

  it('the heuristic is precise: a longer token, a journal with no VAT line and another company\'s journal are not matched; a reference is', async () => {
    const num = number();
    const b = await bill(num, 200);
    await vatOut(fx, acct.vatIn!, acct.cos!, 5, { description: `Reverse VAT on ${num}9` });
    await journal(fx, { description: `Reclass ${num}` }, [
      { glAccountId: acct.cos!, debit: 10, credit: 0 }, { glAccountId: acct.revenue!, debit: 0, credit: 10 },
    ]);
    await vatOut(other, await idOf(other, 'vat_input'), await idOf(other, 'default_expense'), 7, { description: `Reverse VAT on ${num}` });
    const ref = await journal(fx, { description: 'VAT re-claimed', reference: num }, [
      { glAccountId: acct.vatIn!, debit: 4, credit: 0, vatType: 'standard' }, { glAccountId: acct.cos!, debit: 0, credit: 4 },
    ]);

    const h = await history('supplier_invoice', b);
    expect(h.lines.filter((l) => l.tie !== 'posting').map((l) => [l.journal_entry_id, l.tie, l.vat_amount, l.matched_in]))
      .toEqual([[ref, 'reference_match', 4, 'reference']]);
    expect(h.heuristic.journals_matched).toBe(1);
    // A heuristic match that ADDS VAT is reported but never raises what the bill carries (review round 1).
    expect(h.totals).toMatchObject({ vat_heuristic: 4, vat_derivable_now: 30, vat_net_now: 30 });
  });

  it('only HAND journals dated on or after the bill, on its own VAT accounts and no document\'s posting, can match (round 1)', async () => {
    const num = number();
    const b = await bill(num, 1000);
    // Another supplier's bill with the same number, its posting stamped as a migration import (a hand-journal source).
    const other = await bill(num, 1000);
    await sql`UPDATE gl_journal_entries SET source = 'auto_migration' WHERE company_id = ${fx.companyId}::UUID
      AND id = (SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${other}::UUID)`;
    // A document-sourced journal naming the bill (an automatic payment), on the bill's VAT account.
    const auto = await vatOut(fx, acct.vatIn!, acct.cos!, 11, { description: `Payment ${num}` });
    await sql`UPDATE gl_journal_entries SET source = 'auto_payment' WHERE id = ${auto}::UUID AND company_id = ${fx.companyId}::UUID`;
    // A hand journal naming the bill, dated BEFORE it.
    await inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, { entryDate: '2026-05-20', source: 'manual', description: `Pre-bill ${num}`, lines: [
        { glAccountId: acct.cos!, debit: 7, credit: 0 }, { glAccountId: acct.vatIn!, debit: 0, credit: 7, vatType: 'standard' }] }, fx.userId);
      await postJournalEntry(fx.companyId, je.id, fx.userId);
    });
    // A hand journal naming the bill whose VAT sits on another VAT account (output VAT), not the bill's.
    await vatOut(fx, acct.vatOut!, acct.cos!, 13, { description: `Output adj ${num}` });

    const h = await history('supplier_invoice', b);
    expect(h.heuristic.journals_matched).toBe(0);
    expect(h.totals).toMatchObject({ vat_posted: 150, vat_net_now: 150, vat_heuristic: 0 });
  });

  it('a reversed hand-made journal nets out through its chain; a cancelled note nets out too', async () => {
    const num = number();
    const b = await bill(num, 1000);
    const manual = await vatOut(fx, acct.vatIn!, acct.cos!, 150, { description: `VAT on ${num} not claimable` });
    await inTx(fx, () => reverseJournalEntry(fx.companyId, manual, fx.userId));
    const cn = await supplierNote(b, 100);
    await inTx(fx, () => cancelCreditNote(fx.companyId, cn.id, fx.userId, 'issued in error'));

    const h = await history('supplier_invoice', b);
    const narration = h.lines.filter((l) => l.tie === 'narration_match');
    expect(narration.map((l) => [l.vat_amount, l.reversed, l.reverses_journal_id])).toEqual([[-150, true, null], [150, false, manual]]);
    expect(h.lines.filter((l) => l.tie === 'credit_note').map((l) => l.vat_amount)).toEqual([-15, 15]);
    expect(h.totals).toMatchObject({ vat_posted: 150, vat_reversed: 0, vat_net_now: 150, net_base_now: 1000 });
  });

  it('a credit note\'s own history, in its direction; another company\'s token gets Not found', async () => {
    const b = await bill(number(), 500);
    const cn = await supplierNote(b, 500);
    const h = await history('credit_note', cn.id);
    expect(h.lines.map((l) => [l.tie, l.vat_amount, l.net_base])).toEqual([['posting', 75, 500]]);
    expect(h.totals.vat_net_now).toBe(75);

    const ctx = { companyId: other.companyId, userId: other.userId, scopes: ['read:vat', 'read:invoices'] } as unknown as McpToolContext;
    const foreign = await documentVatHistoryTool.handler({ entity_type: 'supplier_invoice', entity_id: b }, ctx);
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]!.text).toBe('Not found');
  });

  it('a cancelled bill no longer names its posting: the reply says so instead of showing nothing silently (A7)', async () => {
    const b = await bill(number(), 300);
    await inTx(fx, () => cancelSupplierInvoice(fx.companyId, b, fx.userId));
    const h = await history('supplier_invoice', b);
    expect(h.lines).toEqual([]);
    expect(h.notes.join(' ')).toContain('This document is cancelled');
    expect(h.heuristic.searched).toBe(false);
  });

  it('a customer invoice: output VAT is positive in its own direction', async () => {
    const inv = await seedInvoice(fx, { number: `INV${String(Date.now()).slice(-6)}`, date: '2026-06-01', total: 230 });
    const je = await journal(fx, { description: 'Invoice posting' }, [
      { glAccountId: acct.ar!, debit: 230, credit: 0 },
      { glAccountId: acct.revenue!, debit: 0, credit: 200 },
      { glAccountId: acct.vatOut!, debit: 0, credit: 30, vatType: 'standard' },
    ]);
    await sql`UPDATE customer_invoices SET gl_journal_entry_id = ${je}::UUID WHERE id = ${inv}::UUID AND company_id = ${fx.companyId}::UUID`;
    const h = await history('customer_invoice', inv);
    expect(h.lines.map((l) => [l.tie, l.vat_amount, l.net_base])).toEqual([['posting', 30, 200]]);
  });
});
