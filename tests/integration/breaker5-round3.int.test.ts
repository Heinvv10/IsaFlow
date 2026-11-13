/**
 * Breaker repros (review round 3), kept as regression tests: R3-1 a supplier refund allocated from the bank to the
 * SUPPLIER with VAT posts as auto_supplier_payment and was skipped by the source list; R3-2 a hand reversal drafted
 * before an acknowledged note and posted after it passed the approve gate. Each failed before round 3.
 * Disposable databases only.
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

describeIfDisposable('breaker5r3', () => {
  beforeAll(async () => {
    fx = await seedFixture('brk7', process.env.DATABASE_URL!);
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

  const draftJournal = (desc: string, amount: number) => inTx(fx, async () => (await createJournalEntry(fx.companyId, {
    entryDate: '2026-06-15', source: 'manual', description: desc,
    lines: [{ glAccountId: acct.cos!, debit: amount, credit: 0 }, { glAccountId: acct.vatIn!, debit: 0, credit: amount, vatType: 'standard' }],
  }, fx.userId)).id);

  it('R3-1: a supplier refund allocated to the SUPPLIER from the bank with VAT (auto_supplier_payment) is not searched', async () => {
    const num = `SIVS${String(Date.now()).slice(-6)}`;
    const a = await bill(num, 1000);
    // bankAllocationService supplier branch, money in, hasVat: DR bank / CR AP net / CR VAT input; narration = statement line.
    await journal(`REFUND ${num}`, 'auto_supplier_payment', [
      { glAccountId: await bank(), debit: 1150, credit: 0 }, { glAccountId: await ap(), debit: 0, credit: 1000 },
      { glAccountId: acct.vatIn!, debit: 0, credit: 150, vatType: 'standard' }]);
    const r = await create(a, 1000);
    expect(r.isError ? 'refused' : `not refused, tax ${String((JSON.parse(text(r)) as Row).tax_amount)}`).toBe('refused');
  });

  it('R3-2: a hand reversal DRAFTED before the acknowledged note and POSTED after it passes the approve gate', async () => {
    const num = `SIVD${String(Date.now()).slice(-6)}`;
    const b = await bill(num, 1000);
    await manualVat(`Slip review 1: half the input VAT on ${num} not claimable`, 75);
    const pending = await draftJournal(`Slip review 2: rest of input VAT on ${num}`, 75); // draft: invisible at create
    await new Promise((res) => setTimeout(res, 20));
    const r = await create(b, 1000, { acknowledge_vat_already_reversed: true, vat_amount: 75 });
    expect(r.isError, text(r)).toBeFalsy();
    await inTx(fx, () => postJournalEntry(fx.companyId, pending, fx.userId));
    const refusal = await approve(String((JSON.parse(text(r)) as Row).id)).then(() => null, (e: unknown) => e);
    const h = (await getDocumentVatHistory(fx.companyId, 'supplier_invoice', b.id))!;
    expect({ approved: refusal === null, net: h.totals.vat_net_now }).toEqual({ approved: false, net: 0 });
  });
});
