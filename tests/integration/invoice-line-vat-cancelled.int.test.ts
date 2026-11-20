/**
 * A CANCELLED typed invoice leaves the VAT201 at zero. customerInvoiceCancelService nulls gl_journal_entry_id, so the
 * invoice's journal is in no `cancelled_entries` list: the original and its reversal (dated with it while the period is
 * open) both count and net to zero in every field. Nothing here depends on a reader change. The cancelled CREDIT NOTE
 * case (its link is kept, so its reversal counts alone in fields 2/3) returns with the follow-up reader PR as a
 * red-first test; see reports/.claude.md (OPEN 2026-11-19).
 *
 * Also the named limit of ar/creditNoteTypedSplit, against a real database: a tiny proportional note can need no VAT,
 * so its standard debit posts with no VAT leg.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { getVat201Return } from '@/modules/accounting/services/reports/vat201Return';
import { getNilRatedSupplies } from '@/modules/accounting/services/reports/vat201NilRatedSupplies';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { journalLegs, L, typeLines } from './helpers/lineVatFixture';

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

const MIXED_ITEMS = [
  { description: 'Standard', unitPrice: 1000 }, { description: 'Export', unitPrice: 300 }, { description: 'Exempt', unitPrice: 200 },
];
const MIXED_TYPES: Record<string, [string, number]> = { Standard: ['standard', 150], Export: ['zero_rated', 0], Exempt: ['exempt', 0] };

const cancel = (id: string) => inTx(f.fx, () => cancelCustomerInvoice(f.fx.companyId, id, f.fx.userId, { allowReversal: true }));
const fields = async (from: string, to: string) => {
  const v = await inTx(f.fx, () => getVat201Return(f.fx.companyId, from, to));
  return [v.field1_standardRatedSupplies, v.field2_zeroRatedSupplies, v.field3_exemptSupplies, v.field5_outputVAT];
};
const nil = async (from: string, to: string) => {
  const n = await inTx(f.fx, () => getNilRatedSupplies(f.fx.companyId, from, to));
  return { zeroRated: n.zeroRated, exempt: n.exempt, onTaxedJournals: n.onTaxedJournals };
};

describeIfDisposable('a cancelled typed invoice leaves the VAT201 at zero (the cancel nulls its journal link)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('a typed exempt invoice of 1000, approved and cancelled in one period: every field 0', async () => {
    const id = await approvedInvoice('2026-07-10', [{ description: 'Rent', unitPrice: 1000 }], 0, { Rent: ['exempt', 0] }, 0);
    expect(await fields('2026-07-01', '2026-07-31')).toEqual([0, 0, 1000, 0]);
    await cancel(id);
    expect(await fields('2026-07-01', '2026-07-31')).toEqual([0, 0, 0, 0]);
  });

  it('a typed mixed invoice cancelled in one period: the nil-rated reader reads nothing and every field is 0', async () => {
    const id = await approvedInvoice('2026-08-10', MIXED_ITEMS, 15, MIXED_TYPES, 150);
    expect(await fields('2026-08-01', '2026-08-31')).toEqual([1000, 300, 200, 150]);
    await cancel(id);
    expect(await nil('2026-08-01', '2026-08-31')).toEqual({ zeroRated: 0, exempt: 0, onTaxedJournals: 0 });
    expect(await fields('2026-08-01', '2026-08-31')).toEqual([0, 0, 0, 0]);
  });

  // Uncoded legs count only on an untaxed document's OWN journal; the cancelled invoice's is excluded by status and its
  // reversal is no document's journal.
  it('a legacy zero-VAT invoice (uncoded legs) cancelled in one period: every field 0', async () => {
    const id = await approvedInvoice('2026-09-10', [{ description: 'Export', unitPrice: 1000 }], 0);
    expect(await fields('2026-09-01', '2026-09-30')).toEqual([0, 1000, 0, 0]);
    await cancel(id);
    expect(await nil('2026-09-01', '2026-09-30')).toEqual({ zeroRated: 0, exempt: 0, onTaxedJournals: 0 });
    expect(await fields('2026-09-01', '2026-09-30')).toEqual([0, 0, 0, 0]);
  });
});

describeIfDisposable('the named limit of a proportional credit note (ar/creditNoteTypedSplit)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('0.03 + 0.00 against the mixed invoice posts standard 0.02 and zero_rated 0.01 with no VAT leg, balanced', async () => {
    const id = await approvedInvoice('2026-10-10', MIXED_ITEMS, 15, MIXED_TYPES, 150);
    const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
      type: 'customer', clientId: f.fx.customerId, customerInvoiceId: id, creditDate: '2026-10-20', subtotal: 0.03, taxRate: 0,
    }, f.fx.userId));
    const je = (await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId))).glJournalEntryId!;
    const legs = await journalLegs(f, je);
    expect(legs).toEqual([
      L('1100', 0, 0.03), L('4000', 0.01, 0, { vat: 'zero_rated' }), L('4000', 0.02, 0, { vat: 'standard' }),
    ]);
    const cents = (k: 'debit' | 'credit') => legs.reduce((s, l) => s + Math.round(l[k] * 100), 0);
    expect(cents('debit')).toBe(cents('credit'));
  });
});
