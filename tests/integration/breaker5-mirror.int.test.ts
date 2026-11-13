/**
 * Breaker repros (review round 1) for document_vat_history + mirror_bill, kept as regression tests. Each comment
 * records what the repro showed before the fix. REPRO 3's expectation is corrected: once approval is refused, the bill
 * still carries 75 of VAT on 1000 of base (the hand journal took 75; nothing else posted). Disposable databases only.
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

describeIfDisposable('breaker5', () => {
  beforeAll(async () => {
    fx = await seedFixture('brk5', process.env.DATABASE_URL!);
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

  it('REPRO 1: two suppliers, same invoice number: bill A inherits bill B VAT; acknowledged note over-reverses', async () => {
    const num = `INV${String(Date.now()).slice(-5)}`;
    const a = await bill(num, 1000);
    await bill(num, 1000); // different supplier, same supplier-issued number
    const h = (await getDocumentVatHistory(fx.companyId, 'supplier_invoice', a.id))!;
    expect(await ledgerVatOf(a.id)).toBe(150);
    expect(h.totals.vat_net_now).toBe(150); // was: 300 (bill B's own posting matched)
  });

  it('REPRO 1b: same, acknowledged mirror note on the clean bill reverses 300 of a 150 VAT bill', async () => {
    const num = `INW${String(Date.now()).slice(-5)}`;
    const a = await bill(num, 1000);
    await bill(num, 1000);
    const refused = await create(a, 1000);
    expect(refused.isError ? text(refused) : 'not refused').toBe('not refused'); // was: refused on a clean bill
  });

  it('REPRO 1c: acknowledged, the note posts 300 VAT against a bill that claimed 150', async () => {
    const num = `INX${String(Date.now()).slice(-5)}`;
    const a = await bill(num, 1000);
    await bill(num, 1000);
    const r = await create(a, 1000, { acknowledge_vat_already_reversed: true });
    expect(r.isError, text(r)).toBeFalsy();
    await approve(String((JSON.parse(text(r)) as Row).id));
    expect(await ledgerVatOf(a.id)).toBe(0); // was: -150 (input VAT reversed twice)
  });

  it('REPRO 2: separator suffix: bill SIVH-n matches another bill SIVH-n-2', async () => {
    const num = `SIVH-${String(Date.now()).slice(-5)}`;
    const s = await seedSupplier(fx, `brk-${++seq}`);
    const a = await bill(num, 1000, s);
    await bill(`${num}-2`, 1000, s);
    const h = (await getDocumentVatHistory(fx.companyId, 'supplier_invoice', a.id))!;
    expect(h.totals.vat_net_now).toBe(150); // was: 300 (SIVH-n matched inside SIVH-n-2)
  });

  it('REPRO 3: approve re-check lets a partial mirrored draft reverse VAT a journal already reversed', async () => {
    const num = `SIVP${String(Date.now()).slice(-6)}`;
    const b = await bill(num, 1000);
    const r = await create(b, 500);
    expect(r.isError, text(r)).toBeFalsy();
    const id = String((JSON.parse(text(r)) as Row).id);
    expect((JSON.parse(text(r)) as Row).tax_amount).toBe(75);
    // After the draft: the slip review reverses the returned half's VAT by hand, naming the bill.
    await manualVat(`Slip review: input VAT on ${num} returned goods`, 75);
    // A fresh mirrored create for the same 500 now would be refused (out of proportion)...
    const fresh = await create(b, 1, {});
    // ...but the existing draft approves and reverses the same 75 a second time.
    const refusal = await approve(id).then(() => null, (e: unknown) => e);
    expect(refusal).toBeInstanceOf(MirroredNoteVatRefusal);
    const approved = refusal === null;
    const h = (await getDocumentVatHistory(fx.companyId, 'supplier_invoice', b.id))!;
    expect({ freshRefused: fresh.isError === true, approved, net: h.totals.vat_net_now, base: h.totals.net_base_now })
      .toEqual({ freshRefused: true, approved: false, net: 75, base: 1000 }); // was: approved, net 0 on base 500
  });

  it('REPRO 4: an all-digit 5-char bill number is searched (on the bill\'s own VAT accounts), so the hand reversal is found', async () => {
    const num = String(Date.now()).slice(-5).replace(/^0/, '1');
    const b = await bill(num, 1000);
    await manualVat(`Slip review: input VAT on ${num} not claimable`, 150);
    const r = await create(b, 1000);
    expect(r.isError).toBe(true); // was: not refused, note carried 150 (an all-digit 5-char number was never searched)
  });
});
