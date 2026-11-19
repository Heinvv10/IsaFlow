/**
 * Migration 1008, the posting half: a customer invoice whose lines carry their VAT type (inserted directly: no writer
 * sets the type yet) approves through the real service into one revenue leg per type and one VAT Output leg per rated
 * type, each coded; the VAT201 the route serves (getVat201Return) then reads it into fields 1, 2, 3 and 5. A legacy
 * invoice made by the create service keeps NULL line VAT and posts the old shape. A partly typed invoice is refused
 * at approve with nothing written. The two report reads this PR touched read both shapes: generateVAT201's drill-down
 * label and getVATReturn's standard-rated base.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { getVat201Return } from '@/modules/accounting/services/reports/vat201Return';
import { generateVAT201 } from '@/modules/accounting/services/reports/vat201Service';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { journalLegs, L, typeLines } from './helpers/lineVatFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

async function draft(invoiceDate: string, items: { description: string; unitPrice: number }[]): Promise<string> {
  return (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate, taxRate: 15, items,
  }))).id;
}
const approve = (id: string) => inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));

describeIfDisposable('a customer invoice whose lines carry their VAT type (migration 1008)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('posts a revenue leg per type and a VAT Output leg per rated type, and the VAT201 reads fields 1, 2, 3 and 5', async () => {
    const id = await draft('2026-07-15', [
      { description: 'Standard', unitPrice: 1000 }, { description: 'Export', unitPrice: 300 }, { description: 'Exempt', unitPrice: 200 },
    ]);
    await typeLines(id, { Standard: ['standard', 150], Export: ['zero_rated', 0], Exempt: ['exempt', 0] }, { tax: 150 });
    const { glJournalEntryId } = await approve(id);
    expect(await journalLegs(f, glJournalEntryId!)).toEqual([
      L('1100', 1650, 0),
      L('2120', 0, 150, { vat: 'standard' }),
      L('4000', 0, 200, { vat: 'exempt' }),
      L('4000', 0, 300, { vat: 'zero_rated' }),
      L('4000', 0, 1000, { vat: 'standard' }),
    ]);

    const vat201 = await inTx(f.fx, () => getVat201Return(f.fx.companyId, '2026-07-01', '2026-07-31'));
    expect([vat201.field1_standardRatedSupplies, vat201.field2_zeroRatedSupplies, vat201.field3_exemptSupplies,
      vat201.field5_outputVAT]).toEqual([1000, 300, 200, 150]);
    // The drill-down label reads the VAT Output leg, not an arbitrary coded revenue leg.
    expect(vat201.outputInvoices.map((i) => [i.vatType, i.totalExclVat, i.vatAmount])).toEqual([['standard', 1500, 150]]);
    // getVATReturn's standard-rated base: the rated line's net, not the subtotal.
    expect((await inTx(f.fx, () => getVATReturn(f.fx.companyId, '2026-07-01', '2026-07-31'))).standardRatedSupplies).toBe(1000);
  });

  it('a legacy invoice from the create service keeps NULL line VAT and posts the old shape; the reports read it as before', async () => {
    const id = await draft('2026-08-15', [{ description: 'A', unitPrice: 600 }, { description: 'B', unitPrice: 400 }]);
    expect((await sql`SELECT vat_type, tax_amount FROM customer_invoice_items WHERE invoice_id = ${id}::UUID`))
      .toEqual([{ vat_type: null, tax_amount: null }, { vat_type: null, tax_amount: null }]);
    expect(((await sql`SELECT amounts_are FROM customer_invoices WHERE id = ${id}::UUID`) as { amounts_are: unknown }[])[0]!.amounts_are)
      .toBeNull();
    const { glJournalEntryId } = await approve(id);
    expect(await journalLegs(f, glJournalEntryId!)).toEqual([L('1100', 1150, 0), L('2120', 0, 150, { vat: 'standard' }), L('4000', 0, 1000)]);
    const vat201 = await inTx(f.fx, () => getVat201Return(f.fx.companyId, '2026-08-01', '2026-08-31'));
    expect([vat201.field1_standardRatedSupplies, vat201.field2_zeroRatedSupplies, vat201.field3_exemptSupplies,
      vat201.field5_outputVAT]).toEqual([1000, 0, 0, 150]);
    expect(vat201.outputInvoices.map((i) => i.vatType)).toEqual(['standard']);
    expect((await inTx(f.fx, () => getVATReturn(f.fx.companyId, '2026-08-01', '2026-08-31'))).standardRatedSupplies).toBe(1000);
  });

  it('a wholly exempt typed invoice posts no VAT leg; its drill-down label and standard-rated base say so', async () => {
    // The header keeps the 15% the create service wrote: a legacy read would call it standard-rated.
    const id = await draft('2026-09-15', [{ description: 'Rent', unitPrice: 1000 }]);
    await typeLines(id, { Rent: ['exempt', 0] }, { tax: 0 });
    const { glJournalEntryId } = await approve(id);
    expect(await journalLegs(f, glJournalEntryId!)).toEqual([L('1100', 1000, 0), L('4000', 0, 1000, { vat: 'exempt' })]);
    const vat201 = await inTx(f.fx, () => getVat201Return(f.fx.companyId, '2026-09-01', '2026-09-30'));
    expect([vat201.field1_standardRatedSupplies, vat201.field3_exemptSupplies, vat201.field5_outputVAT]).toEqual([0, 1000, 0]);
    expect(vat201.outputInvoices.map((i) => i.vatType)).toEqual(['exempt']);
    expect((await inTx(f.fx, () => getVATReturn(f.fx.companyId, '2026-09-01', '2026-09-30'))).standardRatedSupplies).toBe(0);
  });

  it('an inclusive invoice posts each line\'s stored net and VAT: unit price 115 incl., amount 100, VAT 15', async () => {
    const id = await draft('2026-11-10', [{ description: 'Inclusive', unitPrice: 100 }]);
    await typeLines(id, { Inclusive: ['standard', 15] }, { tax: 15 });
    await sql`UPDATE customer_invoice_items SET unit_price = 115 WHERE invoice_id = ${id}::UUID`;
    await sql`UPDATE customer_invoices SET amounts_are = 'inclusive' WHERE id = ${id}::UUID`;
    const { glJournalEntryId } = await approve(id);
    expect(await journalLegs(f, glJournalEntryId!)).toEqual([
      L('1100', 115, 0), L('2120', 0, 15, { vat: 'standard' }), L('4000', 0, 100, { vat: 'standard' }),
    ]);
    expect((await inTx(f.fx, () => getVATReturn(f.fx.companyId, '2026-11-01', '2026-11-30'))).standardRatedSupplies).toBe(100);
  });

  it('a legacy zero-VAT invoice: no VAT leg, so the drill-down label falls back to the header rate (zero_rated)', async () => {
    const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
      clientId: f.fx.customerId, invoiceDate: '2026-12-05', taxRate: 0, items: [{ description: 'Export', unitPrice: 500 }],
    }))).id;
    const { glJournalEntryId } = await approve(id);
    expect(await journalLegs(f, glJournalEntryId!)).toEqual([L('1100', 500, 0), L('4000', 0, 500)]);
    const vat201 = await inTx(f.fx, () => getVat201Return(f.fx.companyId, '2026-12-01', '2026-12-31'));
    expect(vat201.outputInvoices.map((i) => [i.vatType, i.totalExclVat, i.vatAmount])).toEqual([['zero_rated', 500, 0]]);
  });

  it('refuses a partly typed invoice at approve, writing nothing', async () => {
    const id = await draft('2026-10-15', [{ description: 'Typed', unitPrice: 100 }, { description: 'Plain', unitPrice: 100 }]);
    await typeLines(id, { Typed: ['standard', 15] });
    const err = await approve(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect((err as Error).message).toMatch(/some of its lines carry a VAT type and some do not\. Re-save the draft/);
    expect(await sql`SELECT status, gl_journal_entry_id FROM customer_invoices WHERE id = ${id}::UUID`)
      .toEqual([{ status: 'draft', gl_journal_entry_id: null }]);
  });

  it('refuses typed lines whose VAT does not foot to the header at approve, writing nothing', async () => {
    const id = await draft('2026-10-16', [{ description: 'Typed', unitPrice: 100 }]);
    await typeLines(id, { Typed: ['standard', 15] }, { tax: 15.01 });
    const err = await approve(id).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/its lines' VAT adds up to 15\.00 but its VAT total is 15\.01/);
    expect(await sql`SELECT status FROM customer_invoices WHERE id = ${id}::UUID`).toEqual([{ status: 'draft' }]);
  });
});
