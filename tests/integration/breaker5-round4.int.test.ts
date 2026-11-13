/**
 * Breaker repros (review round 4), kept as regression tests. R4-2: a hand reversal naming the bill on a SECOND input-VAT
 * account was never searched (the search covered only the bill's own VAT account; it now covers the VAT side). R4-1:
 * an in-place change brings a journal into the match set after an acknowledged note without touching a timestamp. The
 * breaker's draft merged a second vat_input account into the bill's: that account is now searched at create (R4-2), and
 * a merge across the VAT boundary is refused by accountMergeGuards (asserted below), so the in-place class is exercised
 * by the line UPDATE a merge performs (gl_account_id moved in place), applied directly.
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { mergeAccounts } from '@/modules/accounting/services/gl/accountMergeService';
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

describeIfDisposable('breaker5r4', () => {
  beforeAll(async () => {
    fx = await seedFixture('brk8', process.env.DATABASE_URL!);
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
    // An account merge records itself; its row names both accounts (vatLateClaimFixture.dropLateFixture does the same).
    await sql`DELETE FROM gl_account_merges WHERE company_id = ${c}::UUID`;
    await dropFixture(fx);
  }, 120000);
  const journal = (desc: string, source: string, lines: { glAccountId: string; debit: number; credit: number; vatType?: string }[]) =>
    inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, { entryDate: '2026-06-15', source: source as never, description: desc, lines: lines as never }, fx.userId);
      await postJournalEntry(fx.companyId, je.id, fx.userId);
    });
  const ap = async () => String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'payable' LIMIT 1`) as Row[])[0]!.id);
  const bank = async () => String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'bank' LIMIT 1`) as Row[])[0]?.id ?? acct.cos);

  it('R4-1: a reversal merged INTO the bill\'s VAT account after an acknowledged note is refused at approve', async () => {
    const num = `SIVM${String(Date.now()).slice(-6)}`;
    const b = await bill(num, 1000);
    const old = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '1190', ${`VAT suspense ${fx.tag}`}, 'asset', NULL, 'debit', true) RETURNING id`) as Row[])[0]!.id);
    await manualVat(`Slip review 1: half the input VAT on ${num} not claimable`, 75);
    await journal(`Slip review 2: rest of input VAT on ${num}`, 'manual', [
      { glAccountId: acct.cos!, debit: 75, credit: 0 }, { glAccountId: old, debit: 0, credit: 75 }]);
    await new Promise((res) => setTimeout(res, 20));
    // At create only slip review 1 moves the bill's VAT: acknowledging it with 75 is right at that moment.
    const r = await create(b, 1000, { acknowledge_vat_already_reversed: true, vat_amount: 75 });
    expect(r.isError, text(r)).toBeFalsy();
    // The merge guard refuses moving lines across the VAT boundary...
    await expect(inTx(fx, () => mergeAccounts(fx.companyId, old, acct.vatIn!, fx.userId))).rejects.toThrow(/different populations/);
    // ...so stand in for an in-place change with the UPDATE a merge performs: same journal, same timestamps.
    await sql`UPDATE gl_journal_lines SET gl_account_id = ${acct.vatIn!}::UUID, vat_type = 'standard'
      WHERE company_id = ${fx.companyId}::UUID AND gl_account_id = ${old}::UUID`;
    const refusal = await approve(String((JSON.parse(text(r)) as Row).id)).then(() => null, (e: unknown) => e);
    const h = (await getDocumentVatHistory(fx.companyId, 'supplier_invoice', b.id))!;
    expect({ approved: refusal === null, net: h.totals.vat_net_now }).toEqual({ approved: false, net: 0 });
  });
  it('R4-2: a hand VAT reversal naming the bill on a SECOND vat_input account (a VAT201 input line) is never searched', async () => {
    const num = `SIVQ${String(Date.now()).slice(-6)}`;
    const b = await bill(num, 1000);
    const other = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '1142', ${`Input VAT branch ${fx.tag}`}, 'asset', 'vat_input', 'debit', true) RETURNING id`) as Row[])[0]!.id);
    await journal(`Slip review: input VAT on ${num} not claimable`, 'manual', [
      { glAccountId: acct.cos!, debit: 150, credit: 0 }, { glAccountId: other, debit: 0, credit: 150, vatType: 'standard' }]);
    const r = await create(b, 1000);
    expect(r.isError ? 'refused' : `not refused, tax ${String((JSON.parse(text(r)) as Row).tax_amount)}`).toBe('refused');
  });
});
