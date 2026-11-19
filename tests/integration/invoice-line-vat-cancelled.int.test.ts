/**
 * A CANCELLED document drops out of VAT201 fields 2 and 3 with BOTH its journals. reports/vat201NilRatedSupplies leaves
 * out a cancelled document's linked journal (cancelled_entries). A cancelled CREDIT NOTE keeps its link
 * (creditNoteCancelService), so its original was left out while its reversal (own id, posted on the original's date
 * while that period is open) stayed in: a coded nil-rated debit reversed was counted on its own. Against a typed invoice
 * (migration 1008) a note's revenue legs are coded, so a full note on an exempt invoice of 1000, approved and cancelled
 * in one period, read field 3 = 2000 (and field 1 gave the extra share back). The reversals of those entries are now
 * left out too.
 *
 * A cancelled INVOICE was never affected: customerInvoiceCancelService nulls gl_journal_entry_id, so neither journal is
 * in cancelled_entries and the pair nets to zero; the invoice cases below pin that, before and after the fix. Uncoded
 * (legacy) legs count only on an untaxed document's own journal, which a reversal is not.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { cancelCreditNote, createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { getVat201Return } from '@/modules/accounting/services/reports/vat201Return';
import { getNilRatedSupplies } from '@/modules/accounting/services/reports/vat201NilRatedSupplies';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { typeLines } from './helpers/lineVatFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

async function approvedInvoice(date: string, items: { description: string; unitPrice: number }[], taxRate: number,
  types?: Record<string, [string, number]>, tax?: number): Promise<string> {
  const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: date, taxRate, items,
  }))).id;
  if (types) await typeLines(id, types, { tax });
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
}

const cancel = (id: string) => inTx(f.fx, () => cancelCustomerInvoice(f.fx.companyId, id, f.fx.userId));
const fields = async (from: string, to: string) => {
  const v = await inTx(f.fx, () => getVat201Return(f.fx.companyId, from, to));
  return [v.field1_standardRatedSupplies, v.field2_zeroRatedSupplies, v.field3_exemptSupplies, v.field5_outputVAT];
};
const nil = async (from: string, to: string) => {
  const n = await inTx(f.fx, () => getNilRatedSupplies(f.fx.companyId, from, to));
  return { zeroRated: n.zeroRated, exempt: n.exempt, onTaxedJournals: n.onTaxedJournals };
};

describeIfDisposable('a cancelled document leaves VAT201 fields 2 and 3 with both its journals', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('a full note on a typed exempt invoice of 1000, approved and cancelled in one period: field 3 back to 1000', async () => {
    const id = await approvedInvoice('2026-06-10', [{ description: 'Rent', unitPrice: 1000 }], 0, { Rent: ['exempt', 0] }, 0);
    const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
      type: 'customer', clientId: f.fx.customerId, customerInvoiceId: id, creditDate: '2026-06-20', subtotal: 1000, taxRate: 0,
    }, f.fx.userId));
    await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId));
    expect(await fields('2026-06-01', '2026-06-30')).toEqual([0, 0, 0, 0]);
    await inTx(f.fx, () => cancelCreditNote(f.fx.companyId, cn.id, f.fx.userId));
    expect(await nil('2026-06-01', '2026-06-30')).toEqual({ zeroRated: 0, exempt: 1000, onTaxedJournals: 0 });
    expect(await fields('2026-06-01', '2026-06-30')).toEqual([0, 0, 1000, 0]);
  });

  it('a typed exempt invoice of 1000, approved and cancelled in one period: every field 0', async () => {
    const id = await approvedInvoice('2026-07-10', [{ description: 'Rent', unitPrice: 1000 }], 0, { Rent: ['exempt', 0] }, 0);
    expect(await fields('2026-07-01', '2026-07-31')).toEqual([0, 0, 1000, 0]);
    await cancel(id);
    expect(await fields('2026-07-01', '2026-07-31')).toEqual([0, 0, 0, 0]);
  });

  it('a typed mixed invoice cancelled in one period: the box basis and the nil-rated reader agree on nothing', async () => {
    const id = await approvedInvoice('2026-08-10', [
      { description: 'Standard', unitPrice: 1000 }, { description: 'Export', unitPrice: 300 }, { description: 'Exempt', unitPrice: 200 },
    ], 15, { Standard: ['standard', 150], Export: ['zero_rated', 0], Exempt: ['exempt', 0] }, 150);
    expect(await fields('2026-08-01', '2026-08-31')).toEqual([1000, 300, 200, 150]);
    await cancel(id);
    expect(await nil('2026-08-01', '2026-08-31')).toEqual({ zeroRated: 0, exempt: 0, onTaxedJournals: 0 });
    expect(await fields('2026-08-01', '2026-08-31')).toEqual([0, 0, 0, 0]);
  });

  // Unchanged by the fix (it passed before it): uncoded legs count only on an untaxed document's OWN journal, and the
  // cancelled invoice's is excluded; its reversal is no document's journal, so it never counted.
  it('a legacy zero-VAT invoice (uncoded legs) cancelled in one period: every field 0, as before', async () => {
    const id = await approvedInvoice('2026-09-10', [{ description: 'Export', unitPrice: 1000 }], 0);
    expect(await fields('2026-09-01', '2026-09-30')).toEqual([0, 1000, 0, 0]);
    await cancel(id);
    expect(await nil('2026-09-01', '2026-09-30')).toEqual({ zeroRated: 0, exempt: 0, onTaxedJournals: 0 });
    expect(await fields('2026-09-01', '2026-09-30')).toEqual([0, 0, 0, 0]);
  });
});
