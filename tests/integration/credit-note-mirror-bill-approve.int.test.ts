/**
 * Migration 988 against a real ledger: a mirror_bill draft is re-checked at APPROVE against the VAT its
 * bill still carries. A hand-made journal reverses the bill's VAT after the draft was created → the
 * approval is refused (VAT_ALREADY_REVERSED), nothing posts, the draft stays a draft. A note at its own
 * rate is unchanged. bulk_approve_credit_notes skips the refused note (dry run and live alike) and posts
 * the rest. The migration itself is applied by the runner as the non-superuser deploy role.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { MirroredNoteVatRefusal } from '@/modules/accounting/services/ap/supplierCreditNoteMirrorApprove';
import { getDocumentVatHistory } from '@/modules/accounting/services/reports/documentVatHistory';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import { bulkApproveCreditNotesTool } from '@/lib/mcp/tools/writeBulkApproveCreditNotes';
import { thrownToolErrorText } from '@/lib/mcp/thrownToolErrorText';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropFixture, inTx, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let seq = 0;
const acct: Record<string, string> = {};
const ctx = () => ({ companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti', scopes: ['write:invoices', 'write:post'] }) as unknown as McpToolContext;
const body = (r: McpToolResult) => JSON.parse(r.content[0]!.text) as Row;

async function bill(amount: number) {
  const supplierId = await seedSupplier(fx, `mapr-${++seq}`);
  const num = `SIVM${String(Date.now()).slice(-6)}${seq}`;
  const created = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId, invoiceNumber: num, invoiceDate: '2026-06-01',
    items: [{ description: 'Line', quantity: 1, unitPrice: amount, glAccountId: acct.cos! }],
  }, fx.userId));
  await inTx(fx, () => approveSupplierInvoice(fx.companyId, created.id, fx.userId));
  return { id: created.id, supplierId, num };
}
const mirrored = async (b: { id: string; supplierId: string }, subtotal: number, extra: Record<string, unknown> = {}) => {
  const r = await inTx(fx, () => createCreditNoteTool.handler({
    type: 'supplier', supplier_id: b.supplierId, supplier_invoice_id: b.id, credit_date: '2026-06-20', subtotal,
    mirror_bill: true, idempotency_key: `k-${++seq}`, ...extra,
  }, ctx()));
  expect(r.isError, r.content[0]!.text).toBeFalsy();
  return String(body(r).id);
};
const atRate = (b: { id: string; supplierId: string }, subtotal: number) => inTx(fx, async () => (await createCreditNote(fx.companyId, {
  type: 'supplier', supplierId: b.supplierId, supplierInvoiceId: b.id, creditDate: '2026-06-21', subtotal,
}, fx.userId)).id);
const approve = (id: string) => inTx(fx, () => approveCreditNote(fx.companyId, id, fx.userId));
const note = async (id: string) => ((await sql`
  SELECT status, gl_journal_entry_id, vat_basis FROM credit_notes WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as Row[])[0]!;
const journals = async () => Number(((await sql`SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n);
const reverseVatByHand = (num: string, amount: number) => inTx(fx, async () => {
  const je = await createJournalEntry(fx.companyId, {
    entryDate: '2026-06-15', source: 'manual', description: `Slip review: input VAT on ${num} not claimable`,
    lines: [{ glAccountId: acct.cos!, debit: amount, credit: 0 }, { glAccountId: acct.vatIn!, debit: 0, credit: amount, vatType: 'standard' }],
  }, fx.userId);
  await postJournalEntry(fx.companyId, je.id, fx.userId);
});

describeIfDisposable('mirror_bill notes are re-checked at approve (988)', () => {
  beforeAll(async () => {
    fx = await seedFixture('mapr', process.env.DATABASE_URL!);
    acct.cos = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '5010', ${`COS ${fx.tag}`}, 'expense', 'debit', true) RETURNING id`) as Row[])[0]!.id);
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

  it('the create stores vat_basis: mirror_bill for a mirrored note, rate otherwise; the CHECK refuses anything else', async () => {
    const b = await bill(1000);
    expect((await note(await mirrored(b, 100))).vat_basis).toBe('mirror_bill');
    expect((await note(await atRate(b, 100))).vat_basis).toBe('rate');
    await expect(sql`UPDATE credit_notes SET vat_basis = 'other' WHERE company_id = ${fx.companyId}::UUID`).rejects.toMatchObject({ code: '23514' });
  });

  it('a hand journal reverses the VAT after the mirrored draft: approve is refused, nothing posts; a note at its own rate still approves', async () => {
    const b = await bill(1000);
    const m = await mirrored(b, 1000);
    await reverseVatByHand(b.num, 150);
    const before = await journals();
    const err = await approve(m).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MirroredNoteVatRefusal);
    const text = thrownToolErrorText('approve_credit_note', err);
    expect(text).toMatch(/^VAT_ALREADY_REVERSED: credit note \S+ was raised with mirror_bill on bill \S+, which has changed since/);
    expect(text).toMatch(/JE-\d{4}-\d+ narration_match/);
    expect(text).toContain('Cancel this draft with cancel_credit_note');
    expect(await note(m)).toMatchObject({ status: 'draft', gl_journal_entry_id: null });
    expect(await journals()).toBe(before);

    const r = await atRate(b, 100);
    await approve(r);
    expect((await note(r)).status).not.toBe('draft');
  });

  it('bulk: a mirrored note the bill can no longer carry is skipped (dry run and live alike), the rest posts', async () => {
    const b = await bill(1000);
    const m1 = await mirrored(b, 500);
    const m2 = await mirrored(b, 500, { duplicate_of: m1 });
    await approve(await atRate(b, 500));
    const call = (dry: boolean) => inTx(fx, () => bulkApproveCreditNotesTool.handler(
      { credit_note_ids: [m1, m2], dry_run: dry, idempotency_key: `bk-${++seq}` }, ctx()));
    const [first, second] = [m1, m2].sort();
    const preview = body(await call(true));
    expect(preview).toMatchObject({ would_post_ids: [first] });
    expect((preview.skipped as Row[]).map((s) => [s.document_id, String(s.reason).slice(0, 42)]))
      .toEqual([[second, 'vat_already_reversed: VAT_ALREADY_REVERSED']]);
    const live = body(await call(false));
    expect(live).toMatchObject({ posted: 1 });
    expect((live.skipped as Row[]).map((s) => s.document_id)).toEqual([second]);
    expect((await note(second!)).status).toBe('draft');
    expect((await getDocumentVatHistory(fx.companyId, 'supplier_invoice', b.id))!.totals.vat_net_now).toBe(0);
  });
});
