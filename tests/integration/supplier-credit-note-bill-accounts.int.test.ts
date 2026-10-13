/**
 * Migration 892: a SUPPLIER credit note linked to a bill credits the bill's own
 * expense legs (account, CC1, CC2, BU, job) pro rata, each capped at what it
 * still carries as credit_note_expense_allocations records it; what no leg can
 * take goes to the note's own account, else default_expense. Before 892 every
 * supplier note credited default_expense (5100) — Velocity Fibre re-pointed
 * R8.54m off it by journal on 13 Oct 2026. AP and VAT legs are unchanged.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { CreditNoteDimensionRefusal } from '@/modules/accounting/services/ar/creditNoteHeaderTags';
import { BillLineAccountRefusal } from '@/modules/accounting/services/ap/billLineAccountGuard';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropFixture, inTx, seedBill, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let seq = 0;
const acct: Record<string, string> = {};
const dim: Record<string, string> = {};

async function account(code: string, subtype: string | null = null): Promise<string> {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
    VALUES (${fx.companyId}::UUID, ${code}, ${`${code} ${fx.tag}`}, 'expense', ${subtype}, 'debit', true)
    RETURNING id`) as Row[])[0]!.id);
}

/** An approved bill (15% VAT) whose lines name their own accounts and dimensions. */
async function bill(lines: { amount: number; glAccountId: string; cc1Id?: string; buId?: string }[], supplierId: string) {
  const created = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId, invoiceNumber: `SCN${++seq}-${fx.tag}`.slice(0, 50), invoiceDate: '2026-06-01',
    items: lines.map((l) => ({ description: 'Line', quantity: 1, unitPrice: l.amount, glAccountId: l.glAccountId,
      ...(l.cc1Id ? { cc1Id: l.cc1Id } : {}), ...(l.buId ? { buId: l.buId } : {}) })),
  }, fx.userId));
  await inTx(fx, () => approveSupplierInvoice(fx.companyId, created.id, fx.userId));
  return created.id;
}

const draft = async (supplierId: string, billId: string | null, subtotal: number, extra: Record<string, string> = {}) =>
  (await inTx(fx, () => createCreditNote(fx.companyId, {
    type: 'supplier', supplierId, supplierInvoiceId: billId ?? undefined, creditDate: '2026-06-10', subtotal, ...extra,
  }, fx.userId))).id;
const approve = (id: string) => inTx(fx, () => approveCreditNote(fx.companyId, id, fx.userId));

/** A note's journal, `code[/cc1][/bu]` → signed credit (AP and VAT under their own codes). */
async function noteJournal(id: string): Promise<Record<string, number>> {
  const rows = (await sql`
    SELECT a.account_code AS code, jl.cc1_id, jl.bu_id, jl.vat_type, SUM(jl.credit - jl.debit)::float AS credit
    FROM credit_notes cn JOIN gl_journal_lines jl ON jl.journal_entry_id = cn.gl_journal_entry_id
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE cn.id = ${id}::UUID GROUP BY 1, 2, 3, 4`) as { code: string; cc1_id: string | null; bu_id: string | null; credit: number }[];
  const tag = (v: string | null) => (v === dim.fno ? '/FT' : v === dim.bu ? '/ACT' : v ? '/?' : '');
  return Object.fromEntries(rows.map((r) => [`${r.code}${tag(r.cc1_id)}${tag(r.bu_id)}`, Math.round(r.credit * 100) / 100]));
}

describeIfDisposable('supplier credit notes reverse the bill\'s own accounts (892)', () => {
  beforeAll(async () => {
    fx = await seedFixture('supcn', process.env.DATABASE_URL!);
    acct.cos = await account('5010');
    acct.overheads = await account('5020');
    acct.own = await account('5030');
    dim.fno = String(((await sql`
      INSERT INTO cost_centres (company_id, code, name, cc_type, is_active)
      VALUES (${fx.companyId}::UUID, 'FT', 'Fibertime', 'cc1', true) RETURNING id`) as Row[])[0]!.id);
    dim.bu = String(((await sql`
      INSERT INTO business_units (company_id, code, name, is_active)
      VALUES (${fx.companyId}::UUID, 'ACT', 'Activations', true) RETURNING id`) as Row[])[0]!.id);
  });
  afterAll(async () => {
    if (!fx) return;
    const c = fx.companyId;
    await sql`DELETE FROM credit_note_expense_allocations WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
      SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM cost_centres WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM business_units WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM company_document_numbers WHERE company_id = ${c}::UUID`;
    await dropFixture(fx);
  });

  it('a linked note credits the bill\'s legs with their CC1 / BU; AP = total, VAT = tax, nothing on 5100', async () => {
    const s = await seedSupplier(fx, 'two-line');
    const b = await bill([{ amount: 700, glAccountId: acct.cos!, cc1Id: dim.fno, buId: dim.bu }, { amount: 300, glAccountId: acct.overheads! }], s);
    const n = await draft(s, b, 100);
    await approve(n);
    expect(await noteJournal(n)).toEqual({ '2100': -115, '1140': 15, '5010/FT/ACT': 70, '5020': 30 });
    const rows = await sql`SELECT amount::float AS amount, is_excess FROM credit_note_expense_allocations
      WHERE credit_note_id = ${n}::UUID ORDER BY amount DESC`;
    expect(rows).toEqual([{ amount: 70, is_excess: false }, { amount: 30, is_excess: false }]);
  });

  it('two partial notes respect each leg\'s capacity; a cancel releases it', async () => {
    const s = await seedSupplier(fx, 'capacity');
    const b = await bill([{ amount: 1000, glAccountId: acct.cos! }], s);
    const n1 = await draft(s, b, 600);
    await approve(n1);
    const n2 = await draft(s, b, 600);
    await approve(n2);
    expect(await noteJournal(n2)).toMatchObject({ '5010': 400, '6000': 200 });
    await inTx(fx, () => cancelCreditNote(fx.companyId, n1, fx.userId, 'issued in error'));
    const n3 = await draft(s, b, 600);
    await approve(n3);
    expect(await noteJournal(n3)).toMatchObject({ '5010': 600 });
    expect((await noteJournal(n3))['6000']).toBeUndefined();
  });

  it('a bill with no journal (pre-coding) falls back to the note\'s account, then to default_expense', async () => {
    const s = await seedSupplier(fx, 'no-journal');
    const b = await seedBill(fx, { number: `NJ${++seq}`, date: '2026-06-01', total: 2300, supplierId: s });
    const withAccount = await draft(s, b, 100, { glAccountId: acct.own! });
    await approve(withAccount);
    expect(await noteJournal(withAccount)).toMatchObject({ '5030': 100 });
    const without = await draft(s, b, 100);
    await approve(without);
    expect(await noteJournal(without)).toMatchObject({ '6000': 100 });
  });

  it('an unlinked note posts on its own account with its header CC1', async () => {
    const s = await seedSupplier(fx, 'unlinked');
    const n = await draft(s, null, 200, { glAccountId: acct.own!, cc1Id: dim.fno! });
    await approve(n);
    expect(await noteJournal(n)).toEqual({ '2100': -230, '1140': 30, '5030/FT': 200 });
  });

  it('refuses header CC1 on a linked note, and an AP control account as the note\'s account, before any write', async () => {
    const s = await seedSupplier(fx, 'refusals');
    const b = await bill([{ amount: 100, glAccountId: acct.cos! }], s);
    await expect(draft(s, b, 10, { cc1Id: dim.fno! })).rejects.toBeInstanceOf(CreditNoteDimensionRefusal);
    const ap = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'payable'`) as Row[])[0]!.id);
    await expect(draft(s, b, 10, { glAccountId: ap })).rejects.toBeInstanceOf(BillLineAccountRefusal);
    const notes = await sql`SELECT 1 FROM credit_notes WHERE supplier_id = ${s}::UUID`;
    expect(notes).toHaveLength(0);
  });

  it('concurrent approvals of two notes on one bill are serialised: the leg is never over-credited', async () => {
    const s = await seedSupplier(fx, 'concurrent');
    const b = await bill([{ amount: 1000, glAccountId: acct.cos! }], s);
    const [n1, n2] = [await draft(s, b, 700), await draft(s, b, 700)];
    await Promise.all([approve(n1!), approve(n2!)]);
    const j1 = await noteJournal(n1!);
    const j2 = await noteJournal(n2!);
    expect((j1['5010'] ?? 0) + (j2['5010'] ?? 0)).toBe(1000);
    expect((j1['6000'] ?? 0) + (j2['6000'] ?? 0)).toBe(400);
  });
});
