/**
 * Migration 1008, the credit-note half: a customer credit note linked to a typed invoice debits each revenue leg on
 * that leg's own VAT type, so a full note against an exempt invoice reduces VAT201 field 3 to nothing and leaves
 * field 2 alone (an uncoded debit on an untaxed note read as zero-rated: field 2 -1000, field 3 +1000). A note against
 * a mixed invoice reverses every field. A note against a legacy invoice keeps its uncoded debit, as before.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { getVat201Return } from '@/modules/accounting/services/reports/vat201Return';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { journalLegs, L, typeLines } from './helpers/lineVatFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

async function approvedInvoice(date: string, items: { description: string; unitPrice: number }[],
  types?: Record<string, [string, number]>, tax?: number): Promise<string> {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: date, taxRate: 15, items,
  }))).id;
  if (types) await typeLines(id, types, { tax });
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
}

async function note(invoiceId: string, creditDate: string, subtotal: number, taxRate: number): Promise<string> {
  const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: f.fx.customerId, customerInvoiceId: invoiceId, creditDate, subtotal, taxRate,
  }, f.fx.userId));
  return (await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId))).glJournalEntryId!;
}

const fields = async (from: string, to: string) => {
  const v = await inTx(f.fx, () => getVat201Return(f.fx.companyId, from, to));
  return [v.field1_standardRatedSupplies, v.field2_zeroRatedSupplies, v.field3_exemptSupplies, v.field5_outputVAT];
};

describeIfDisposable('a credit note against a typed invoice (migration 1008)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('a full note against an exempt invoice in the same period: field 3 = 0 and field 2 = 0', async () => {
    const id = await approvedInvoice('2026-07-10', [{ description: 'Rent', unitPrice: 1000 }], { Rent: ['exempt', 0] }, 0);
    expect(await fields('2026-07-01', '2026-07-31')).toEqual([0, 0, 1000, 0]);
    const je = await note(id, '2026-07-20', 1000, 0);
    expect(await journalLegs(f, je)).toEqual([L('1100', 0, 1000), L('4000', 1000, 0, { vat: 'exempt' })]);
    expect(await fields('2026-07-01', '2026-07-31')).toEqual([0, 0, 0, 0]);
  });

  it('a full note against a mixed invoice reverses each field', async () => {
    const id = await approvedInvoice('2026-08-10', [
      { description: 'Standard', unitPrice: 1000 }, { description: 'Export', unitPrice: 300 }, { description: 'Exempt', unitPrice: 200 },
    ], { Standard: ['standard', 150], Export: ['zero_rated', 0], Exempt: ['exempt', 0] }, 150);
    expect(await fields('2026-08-01', '2026-08-31')).toEqual([1000, 300, 200, 150]);
    // The note's own VAT leg stays 'standard' (this PR), carrying the invoice's 150 of VAT: 10% of 1500.
    const je = await note(id, '2026-08-20', 1500, 10);
    expect(await journalLegs(f, je)).toEqual([
      L('1100', 0, 1650), L('2120', 150, 0, { vat: 'standard' }),
      L('4000', 200, 0, { vat: 'exempt' }), L('4000', 300, 0, { vat: 'zero_rated' }), L('4000', 1000, 0, { vat: 'standard' }),
    ]);
    expect(await fields('2026-08-01', '2026-08-31')).toEqual([0, 0, 0, 0]);
  });

  it('a note against a legacy invoice keeps its uncoded revenue debit, as before', async () => {
    const id = await approvedInvoice('2026-09-10', [{ description: 'A', unitPrice: 1000 }]);
    const je = await note(id, '2026-09-20', 400, 15);
    expect(await journalLegs(f, je)).toEqual([L('1100', 0, 460), L('2120', 60, 0, { vat: 'standard' }), L('4000', 400, 0)]);
  });
});
