/**
 * Breaker repros (review round 2) for mirror_bill, kept as regression tests: R2-1 a positive match naming the same
 * number hid a real hand reversal; R2-2 a supplier refund allocated from the bank (auto_bank_recon) was never searched;
 * R2-3 an acknowledged draft approved after a later hand reversal. Each failed before round 2. Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getDocumentVatHistory } from '@/modules/accounting/services/reports/documentVatHistory';
import { MirroredNoteVatRefusal } from '@/modules/accounting/services/ap/supplierCreditNoteMirrorApprove';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropFixture, inTx, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let seq = 0;
const acct: Record<string, string> = {};
const ctx = () => ({ companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti', scopes: ['write:invoices'] }) as unknown as McpToolContext;
const text = (r: McpToolResult) => r.content[0]!.text;

async function bill(num: string, amount: number, supplierId?: string) {
  const sid = supplierId ?? await seedSupplier(fx, `brk-${++seq}`);
  const created = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId: sid, invoiceNumber: num, invoiceDate: '2026-06-01',
    items: [{ description: 'Line', quantity: 1, unitPrice: amount, glAccountId: acct.cos! }],
  }, fx.userId));
  await inTx(fx, () => approveSupplierInvoice(fx.companyId, created.id, fx.userId));
  return { id: created.id, supplierId: sid };
}
const create = (b: { id: string; supplierId: string }, subtotal: number, extra: Record<string, unknown> = {}) =>
  inTx(fx, () => createCreditNoteTool.handler({
    type: 'supplier', supplier_id: b.supplierId, supplier_invoice_id: b.id, credit_date: '2026-06-20', subtotal,
    mirror_bill: true, idempotency_key: `k-${++seq}`, ...extra,
  }, ctx()));
const approve = (id: string) => inTx(fx, () => approveCreditNote(fx.companyId, id, fx.userId));
/** What the VAT201 reads for this bill: VAT lines on its own posting journal and its linked notes' journals. */
async function ledgerVatOf(billId: string): Promise<number> {
  const r = (await sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::float AS v FROM gl_journal_lines jl
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${fx.companyId}::UUID AND ga.account_subtype = 'vat_input' AND jl.journal_entry_id IN (
      SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${billId}::UUID
      UNION SELECT gl_journal_entry_id FROM credit_notes WHERE supplier_invoice_id = ${billId}::UUID AND gl_journal_entry_id IS NOT NULL)`) as Row[];
  return Math.round(Number(r[0]!.v) * 100) / 100;
}
const manualVat = (desc: string, amount: number) => inTx(fx, async () => {
  const je = await createJournalEntry(fx.companyId, {
    entryDate: '2026-06-15', source: 'manual', description: desc,
    lines: [{ glAccountId: acct.cos!, debit: amount, credit: 0 }, { glAccountId: acct.vatIn!, debit: 0, credit: amount, vatType: 'standard' }],
  }, fx.userId);
  await postJournalEntry(fx.companyId, je.id, fx.userId);
});

describeIfDisposable('breaker5r2', () => {
  beforeAll(async () => {
    fx = await seedFixture('brk6', process.env.DATABASE_URL!);
    acct.cos = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '5010', ${`5010 ${fx.tag}`}, 'expense', 'debit', true) RETURNING id`) as Row[])[0]!.id);
    acct.vatIn = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'vat_input'`) as Row[])[0]!.id);
  }, 120000);
  afterAll(async () => {
    if (!fx) return;
    const c = fx.companyId;
    await sql`DELETE FROM credit_note_expense_allocations WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM company_document_numbers WHERE company_id = ${c}::UUID`;
    await dropFixture(fx);
  }, 120000);
  const journal = (desc: string, source: string, lines: { glAccountId: string; debit: number; credit: number; vatType?: string }[]) =>
    inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, { entryDate: '2026-06-15', source: source as never, description: desc, lines: lines as never }, fx.userId);
      await postJournalEntry(fx.companyId, je.id, fx.userId);
    });
  const ap = async () => String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'payable' LIMIT 1`) as Row[])[0]!.id);
  const bank = async () => String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'bank' LIMIT 1`) as Row[])[0]?.id ?? acct.cos);

  it('R2-1: an unrelated POSITIVE hand journal naming the same number masks a real hand reversal; the note reverses twice', async () => {
    const num = `INV${String(Date.now()).slice(-5)}`;
    const a = await bill(num, 1000);
    await manualVat(`Slip review: input VAT on ${num} not claimable`, 150);
    // Supplier Y's invoice with the same number, captured by hand journal.
    await journal(`Supplier Y invoice ${num}`, 'manual', [
      { glAccountId: acct.cos!, debit: 1000, credit: 0 }, { glAccountId: acct.vatIn!, debit: 150, credit: 0, vatType: 'standard' },
      { glAccountId: await ap(), debit: 0, credit: 1150 }]);
    const r = await create(a, 1000);
    expect(r.isError ? 'refused' : `not refused, tax ${String((JSON.parse(text(r)) as Row).tax_amount)}`).toBe('refused');
  });

  it('R2-2: a bank allocation (source auto_bank_recon) refunding the bill with VAT is never searched; mirrored note reverses twice', async () => {
    const num = `SIVR${String(Date.now()).slice(-6)}`;
    const a = await bill(num, 1000);
    // Supplier refund received, allocated by bank statement line to the expense with VAT (bankAllocationService shape).
    await journal(`REFUND ${num}`, 'auto_bank_recon', [
      { glAccountId: await bank(), debit: 1150, credit: 0 }, { glAccountId: acct.cos!, debit: 0, credit: 1000, vatType: 'standard' },
      { glAccountId: acct.vatIn!, debit: 0, credit: 150, vatType: 'standard' }]);
    const r = await create(a, 1000);
    expect(r.isError ? 'refused' : `not refused, tax ${String((JSON.parse(text(r)) as Row).tax_amount)}`).toBe('refused');
  });

  it('R2-3: an acknowledged draft is not re-judged at approve against a hand reversal posted AFTER it; VAT goes negative', async () => {
    const num = `SIVK${String(Date.now()).slice(-6)}`;
    const b = await bill(num, 1000);
    await manualVat(`Slip review 1: half the input VAT on ${num} not claimable`, 75);
    const refused = await create(b, 1000);
    expect(refused.isError).toBe(true);
    const r = await create(b, 1000, { acknowledge_vat_already_reversed: true, vat_amount: 75 });
    expect(r.isError, text(r)).toBeFalsy();
    await manualVat(`Slip review 2: rest of input VAT on ${num} reversed`, 75);
    const refusal = await approve(String((JSON.parse(text(r)) as Row).id)).then(() => null, (e: unknown) => e);
    const h = (await getDocumentVatHistory(fx.companyId, 'supplier_invoice', b.id))!;
    expect({ approved: refusal === null, net: h.totals.vat_net_now }).toEqual({ approved: false, net: 0 });
  });
});
