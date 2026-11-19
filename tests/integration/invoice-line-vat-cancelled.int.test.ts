/**
 * A CANCELLED document and VAT201, in ONE period. Both readers (the box basis, vatBoxBasisQuery, and the nil-rated
 * reader, vat201NilRatedSupplies) hide a cancelled document's journal and its reversal TOGETHER when both fall in the
 * period (the K-032 pair rule, vatCancelledPairSql): the pair contributes nothing. A cancelled CREDIT NOTE keeps its
 * link (creditNoteCancelService), so it is in the pair rule's list; its reversal used to count alone in the nil-rated
 * reader, and a full note on a typed exempt invoice of 1000, approved and cancelled in one period, read field 3 = 2000.
 * A cancelled INVOICE's cancel nulls gl_journal_entry_id, so its journal is in no list: the original and its reversal
 * (dated with it while the period is open) both count and net to zero in every field. The cross-period cases (a filed
 * period, the reversal rolled into the next) are in invoice-line-vat-cancelled-cross-period.
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
import { cancelCreditNote, createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { getVat201Return } from '@/modules/accounting/services/reports/vat201Return';
import { getNilRatedSupplies } from '@/modules/accounting/services/reports/vat201NilRatedSupplies';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { sql } from '@/lib/neon';
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

const cancel = (id: string) => inTx(f.fx, () => cancelCustomerInvoice(f.fx.companyId, id, f.fx.userId));
/** An approved customer note against `invoiceId`; returns its id and journal id. */
async function approvedNote(invoiceId: string, date: string, subtotal: number, taxAmount?: number) {
  const cn = await inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: f.fx.customerId, customerInvoiceId: invoiceId, creditDate: date, subtotal,
    taxRate: taxAmount ? 15 : 0, ...(taxAmount !== undefined ? { taxAmount } : {}),
  }, f.fx.userId));
  const je = (await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId))).glJournalEntryId!;
  return { id: cn.id, je };
}
const cancelNote = (id: string) => inTx(f.fx, () => cancelCreditNote(f.fx.companyId, id, f.fx.userId));
const reversalOf = async (je: string) => String(((await sql`SELECT id FROM gl_journal_entries
  WHERE reversal_of_id = ${je}::UUID AND company_id = ${f.fx.companyId}::UUID`) as { id: string }[])[0]!.id);
const fields = async (from: string, to: string) => {
  const v = await inTx(f.fx, () => getVat201Return(f.fx.companyId, from, to));
  return [v.field1_standardRatedSupplies, v.field2_zeroRatedSupplies, v.field3_exemptSupplies, v.field5_outputVAT];
};
const nil = async (from: string, to: string) => {
  const n = await inTx(f.fx, () => getNilRatedSupplies(f.fx.companyId, from, to));
  return { zeroRated: n.zeroRated, exempt: n.exempt, onTaxedJournals: n.onTaxedJournals };
};

describeIfDisposable('a credit note approved and cancelled in one period: the pair contributes nothing', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('a full note on a typed exempt invoice of 1000, approved and cancelled in one period: field 3 back to 1000', async () => {
    const id = await approvedInvoice('2026-06-10', [{ description: 'Rent', unitPrice: 1000 }], 0, { Rent: ['exempt', 0] }, 0);
    const cn = await approvedNote(id, '2026-06-20', 1000);
    expect(await fields('2026-06-01', '2026-06-30')).toEqual([0, 0, 0, 0]);
    await cancelNote(cn.id);
    expect(await nil('2026-06-01', '2026-06-30')).toEqual({ zeroRated: 0, exempt: 1000, onTaxedJournals: 0 });
    expect(await fields('2026-06-01', '2026-06-30')).toEqual([0, 0, 1000, 0]);
  });

  it('a legacy zero-VAT note (uncoded legs) on a legacy zero-VAT invoice, cancelled in one period: the invoice alone', async () => {
    const id = await approvedInvoice('2026-07-10', [{ description: 'Export', unitPrice: 1000 }], 0);
    const cn = await approvedNote(id, '2026-07-20', 400);
    expect(await fields('2026-07-01', '2026-07-31')).toEqual([0, 600, 0, 0]);
    await cancelNote(cn.id);
    expect(await fields('2026-07-01', '2026-07-31')).toEqual([0, 1000, 0, 0]);
  });

  // The box basis walks the reversal chain (K-032): a hand reversal of the cancel's reversal is hidden with the pair,
  // or it would re-admit the cancelled note. The nil-rated reader shares that rule, so field 1 (the box basis less the
  // nil-rated give-back) and fields 2 and 3 agree.
  it('a typed mixed invoice; its note cancelled, and that reversal reversed by hand, all in one period', async () => {
    const id = await approvedInvoice('2026-08-10', MIXED_ITEMS, 15, MIXED_TYPES, 150);
    const cn = await approvedNote(id, '2026-08-20', 150, 15);
    expect(await fields('2026-08-01', '2026-08-31')).toEqual([900, 270, 180, 135]);
    await cancelNote(cn.id);
    expect(await fields('2026-08-01', '2026-08-31')).toEqual([1000, 300, 200, 150]);
    const r1 = await reversalOf(cn.je);
    await inTx(f.fx, () => reverseJournalEntry(f.fx.companyId, r1, f.fx.userId));
    expect(String(((await sql`SELECT entry_date::TEXT AS d FROM gl_journal_entries
      WHERE id = ${await reversalOf(r1)}::UUID`) as { d: string }[])[0]!.d)).toBe('2026-08-20');
    expect(await nil('2026-08-01', '2026-08-31')).toEqual({ zeroRated: 300, exempt: 200, onTaxedJournals: 500 });
    expect(await fields('2026-08-01', '2026-08-31')).toEqual([1000, 300, 200, 150]);
  });
});

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
