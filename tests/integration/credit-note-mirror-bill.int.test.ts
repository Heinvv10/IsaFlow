/**
 * create_credit_note mirror_bill (brief step 5b) against a real ledger, through the MCP tool.
 *
 *  - SIV3762's shape: a hand-made journal already reversed the bill's input VAT. Without mirror_bill a
 *    note at the 15% default reverses it a SECOND time (reproduced below); with mirror_bill the tool
 *    refuses (VAT_ALREADY_REVERSED, naming the journal) and writes nothing, and once acknowledged the
 *    note carries only the VAT the bill still carries — none — so after approval the bill nets to 0, not
 *    to minus the VAT.
 *  - A clean bill: the note mirrors the bill's accounts and CC1/BU (892, at approve) and its VAT pro rata
 *    as the bill stands, and two halves take exactly the bill's VAT; a third has nothing left to mirror.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getDocumentVatHistory } from '@/modules/accounting/services/reports/documentVatHistory';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { formatMoney } from '@/lib/money/formatMoney';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropFixture, inTx, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let seq = 0;
const acct: Record<string, string> = {};
const dim: Record<string, string> = {};
const ctx = () => ({ companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti', scopes: ['write:invoices'] }) as unknown as McpToolContext;
const text = (r: McpToolResult) => r.content[0]!.text;

async function bill(num: string, lines: { amount: number; glAccountId: string; cc1Id?: string; buId?: string }[]) {
  const supplierId = await seedSupplier(fx, `mirror-${++seq}`);
  const created = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId, invoiceNumber: num, invoiceDate: '2026-06-01',
    items: lines.map((l) => ({ description: 'Line', quantity: 1, unitPrice: l.amount, glAccountId: l.glAccountId,
      ...(l.cc1Id ? { cc1Id: l.cc1Id } : {}), ...(l.buId ? { buId: l.buId } : {}) })),
  }, fx.userId));
  await inTx(fx, () => approveSupplierInvoice(fx.companyId, created.id, fx.userId));
  return { id: created.id, supplierId };
}

const create = (b: { id: string; supplierId: string }, subtotal: number, extra: Record<string, unknown> = {}) =>
  inTx(fx, () => createCreditNoteTool.handler({
    type: 'supplier', supplier_id: b.supplierId, supplier_invoice_id: b.id, credit_date: '2026-06-20', subtotal,
    idempotency_key: `k-${++seq}`, ...extra,
  }, ctx()));
const noteId = (r: McpToolResult) => String((JSON.parse(text(r)) as Row).id);
const approve = (id: string) => inTx(fx, () => approveCreditNote(fx.companyId, id, fx.userId));
const notesOn = async (billId: string) => Number(((await sql`
  SELECT COUNT(*) AS n FROM credit_notes WHERE company_id = ${fx.companyId}::UUID AND supplier_invoice_id = ${billId}::UUID`) as Row[])[0]!.n);

/** A note's journal, `code[/FT][/ACT]` → signed credit. */
async function noteJournal(id: string): Promise<Record<string, number>> {
  const rows = (await sql`
    SELECT a.account_code AS code, jl.cc1_id, jl.bu_id, SUM(jl.credit - jl.debit)::float AS credit
    FROM credit_notes cn JOIN gl_journal_lines jl ON jl.journal_entry_id = cn.gl_journal_entry_id AND jl.company_id = cn.company_id
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE cn.id = ${id}::UUID AND cn.company_id = ${fx.companyId}::UUID GROUP BY 1, 2, 3`) as { code: string; cc1_id: string | null; bu_id: string | null; credit: number }[];
  const tag = (v: string | null) => (v === dim.fno ? '/FT' : v === dim.bu ? '/ACT' : v ? '/?' : '');
  return Object.fromEntries(rows.map((r) => [`${r.code}${tag(r.cc1_id)}${tag(r.bu_id)}`, Math.round(r.credit * 100) / 100]));
}

/** The slip-review journal: DR the expense, CR input VAT, naming the bill. */
const reverseVatByHand = (num: string, amount: number) => inTx(fx, async () => {
  const je = await createJournalEntry(fx.companyId, {
    entryDate: '2026-06-15', source: 'manual', description: `Slip review: input VAT on ${num} not claimable`,
    lines: [{ glAccountId: acct.cos!, debit: amount, credit: 0 }, { glAccountId: acct.vatIn!, debit: 0, credit: amount, vatType: 'standard' }],
  }, fx.userId);
  await postJournalEntry(fx.companyId, je.id, fx.userId);
  return String(((await sql`SELECT entry_number FROM gl_journal_entries WHERE id = ${je.id}::UUID`) as Row[])[0]!.entry_number);
});

describeIfDisposable('create_credit_note mirror_bill', () => {
  beforeAll(async () => {
    fx = await seedFixture('mirror', process.env.DATABASE_URL!);
    const account = async (code: string) => String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, ${code}, ${`${code} ${fx.tag}`}, 'expense', 'debit', true) RETURNING id`) as Row[])[0]!.id);
    acct.cos = await account('5010');
    acct.overheads = await account('5020');
    acct.vatIn = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'vat_input'`) as Row[])[0]!.id);
    dim.fno = String(((await sql`
      INSERT INTO cost_centres (company_id, code, name, cc_type, is_active)
      VALUES (${fx.companyId}::UUID, 'FT', 'Fibertime', 'cc1', true) RETURNING id`) as Row[])[0]!.id);
    dim.bu = String(((await sql`
      INSERT INTO business_units (company_id, code, name, is_active)
      VALUES (${fx.companyId}::UUID, 'ACT', 'Activations', true) RETURNING id`) as Row[])[0]!.id);
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    const c = fx.companyId;
    await sql`DELETE FROM credit_note_expense_allocations WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM cost_centres WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM business_units WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM company_document_numbers WHERE company_id = ${c}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('without mirror_bill a note reverses already-reversed VAT a second time (the SIV3762 defect)', async () => {
    const num = `SIVA${String(Date.now()).slice(-6)}`;
    const b = await bill(num, [{ amount: 1739.13, glAccountId: acct.cos! }]);
    await reverseVatByHand(num, 260.87);
    const r = await create(b, 1739.13);
    await approve(noteId(r));
    const h = (await getDocumentVatHistory(fx.companyId, 'supplier_invoice', b.id))!;
    expect(h.totals).toMatchObject({ vat_posted: 260.87, vat_net_now: -260.87 });
  });

  it('mirror_bill refuses it, names the journal and writes nothing; acknowledged, the note carries no VAT and the bill nets to 0', async () => {
    const num = `SIVB${String(Date.now()).slice(-6)}`;
    const b = await bill(num, [{ amount: 1739.13, glAccountId: acct.cos! }]);
    const manual = await reverseVatByHand(num, 260.87);

    const refused = await create(b, 1739.13, { mirror_bill: true });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/^VAT_ALREADY_REVERSED/);
    expect(text(refused)).toContain(`${manual} narration_match ${formatMoney(-260.87)}`);
    expect(await notesOn(b.id)).toBe(0);

    const r = await create(b, 1739.13, { mirror_bill: true, acknowledge_vat_already_reversed: true });
    expect(r.isError, text(r)).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ tax_amount: 0, total_amount: 1739.13, mirror: { acknowledged_vat_already_reversed: true, vat_out_of_proportion: 260.87 } });
    await approve(noteId(r));
    expect(await noteJournal(noteId(r))).toEqual({ '2100': -1739.13, '5010': 1739.13 });
    const h = (await getDocumentVatHistory(fx.companyId, 'supplier_invoice', b.id))!;
    expect(h.totals).toMatchObject({ vat_posted: 260.87, vat_net_now: 0, net_base_now: 0 });
  });

  it('a clean bill: accounts, CC1/BU and VAT mirrored pro rata as it stands; two halves take exactly its VAT', async () => {
    const b = await bill(`SIVC${String(Date.now()).slice(-6)}`, [
      { amount: 700, glAccountId: acct.cos!, cc1Id: dim.fno, buId: dim.bu }, { amount: 300.01, glAccountId: acct.overheads! },
    ]);
    const first = await create(b, 500, { mirror_bill: true });
    expect(JSON.parse(text(first))).toMatchObject({ tax_amount: 75, mirror: { bill_vat_rate_now: 15, bill_net_base_now: 1000.01 } });
    await approve(noteId(first));
    expect(await noteJournal(noteId(first))).toEqual({ '2100': -575, '1140': 75, '5010/FT/ACT': 350, '5020': 150 });

    const second = await create(b, 500.01, { mirror_bill: true });
    expect(JSON.parse(text(second))).toMatchObject({ tax_amount: 75 });
    await approve(noteId(second));
    const h = (await getDocumentVatHistory(fx.companyId, 'supplier_invoice', b.id))!;
    expect(h.totals).toMatchObject({ vat_posted: 150, vat_net_now: 0, net_base_now: 0 });

    const third = await create(b, 1, { mirror_bill: true });
    expect(text(third)).toContain('There is nothing to mirror');
    expect(await notesOn(b.id)).toBe(2);
  });
});
