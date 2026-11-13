/**
 * Breaker repros (review round 5), kept as regression tests. R5-1: the VAT side was chosen by account subtype, but the
 * VAT201 counts more (vatEntryMemberLineSql): a VAT-coded line on a generic-tax "VAT control" account, or on a plain
 * balance-sheet account. A hand reversal on either was never searched. Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { mergeAccounts } from '@/modules/accounting/services/gl/accountMergeService';
import { vatEntryMemberLineSql } from '@/modules/accounting/services/reports/vatEntryMembership';
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

describeIfDisposable('breaker5r5', () => {
  beforeAll(async () => {
    fx = await seedFixture('brk9', process.env.DATABASE_URL!);
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

  for (const [label, subtype, type] of [['generic tax subtype (VAT control)', 'tax', 'liability'], ['VAT code on a plain balance-sheet account', null, 'asset']] as const) {
    it(`R5-1: a hand VAT reversal on a VAT201 member line outside the vat_input side (${label}) is not searched`, async () => {
      const num = `SIVT${String(Date.now()).slice(-6)}`;
      const b = await bill(num, 1000);
      const ctl = String(((await sql`
        INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
        VALUES (${fx.companyId}::UUID, ${subtype ? '2210' : '1195'}, ${`VAT ctl ${label} ${fx.tag}`}, ${type}, ${subtype}, 'debit', true) RETURNING id`) as Row[])[0]!.id);
      await journal(`Slip review: input VAT on ${num} not claimable`, 'manual', [
        { glAccountId: acct.cos!, debit: 150, credit: 0 }, { glAccountId: ctl, debit: 0, credit: 150, vatType: 'standard' }]);
      const member = (await sql`
        SELECT bool_or(${vatEntryMemberLineSql()}) AS m FROM gl_journal_lines jl JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE jl.company_id = ${fx.companyId}::UUID AND jl.gl_account_id = ${ctl}::UUID`) as Row[];
      expect(member[0]!.m).toBe(true); // the VAT201 counts this line
      const r = await create(b, 1000);
      expect(r.isError ? 'refused' : `not refused, tax ${String((JSON.parse(text(r)) as Row).tax_amount)}`).toBe('refused');
    });
  }
});
