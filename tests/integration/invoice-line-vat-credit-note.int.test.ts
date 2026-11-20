/**
 * Migration 1008, the credit-note half: a customer credit note linked to a typed invoice debits each revenue leg on
 * that leg's own VAT type, so a full note against an exempt invoice reduces VAT201 field 3 to nothing and leaves
 * field 2 alone (an uncoded debit on an untaxed note read as zero-rated: field 2 -1000, field 3 +1000). A note against
 * a mixed invoice reverses every field. A note against a typed invoice is PROPORTIONAL ONLY (Hein, 2026-11-19): its
 * debits spread pro rata over every line, its VAT exactly the invoice's remaining VAT in proportion. A note against a
 * legacy invoice keeps its uncoded debit, as before.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { cancelCreditNote, createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { getVat201Return } from '@/modules/accounting/services/reports/vat201Return';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { sql } from '@/lib/neon';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { journalLegs, L, typeLines, untypeLines } from './helpers/lineVatFixture';

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
  // No types named: a LEGACY invoice, the shape the legacy writers store (create types its lines since the writer PR).
  if (types) await typeLines(id, types, { tax }); else await untypeLines(id);
  await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
  return id;
}

async function draftNote(invoiceId: string, creditDate: string, subtotal: number, taxRate: number, taxAmount?: number) {
  return inTx(f.fx, () => createCreditNote(f.fx.companyId, {
    type: 'customer', clientId: f.fx.customerId, customerInvoiceId: invoiceId, creditDate, subtotal, taxRate,
    ...(taxAmount === undefined ? {} : { taxAmount }),
  }, f.fx.userId));
}

async function note(invoiceId: string, creditDate: string, subtotal: number, taxRate: number, taxAmount?: number): Promise<string> {
  const cn = await draftNote(invoiceId, creditDate, subtotal, taxRate, taxAmount);
  return (await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cn.id, f.fx.userId))).glJournalEntryId!;
}

/** Approve as the route does: a refusal is a 4xx, and withAuth COMMITS a 4xx. Returns the refusal. */
async function approveCommittingRefusal(id: string): Promise<unknown> {
  const c = await f.fx.pool.connect();
  await c.query('BEGIN');
  try {
    return await runOn(f.fx, c, () => approveCreditNote(f.fx.companyId, id, f.fx.userId)).then(() => null, (e: unknown) => e);
  } finally {
    await c.query('COMMIT');
    c.release();
  }
}

/** Everything a refused approval must have left alone. */
const footprint = async (noteId: string, invoiceId: string, noteNumber: string) => ({
  note: await sql`SELECT status, gl_journal_entry_id, applied_amount FROM credit_notes WHERE id = ${noteId}::UUID`,
  journals: await sql`SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${f.fx.companyId}::UUID`,
  lines: await sql`SELECT COUNT(*)::INT AS n FROM gl_journal_lines WHERE company_id = ${f.fx.companyId}::UUID
                   AND description LIKE ${`%${noteNumber}%`}`,
  allocations: await sql`SELECT COUNT(*)::INT AS n FROM credit_note_revenue_allocations WHERE credit_note_id = ${noteId}::UUID`,
  invoice: await sql`SELECT status, amount_paid, subtotal, tax_amount, total_amount FROM customer_invoices WHERE id = ${invoiceId}::UUID`,
});

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
    // It clears the net, so it carries all 150 of the VAT left (10% of 1500); its own VAT leg stays 'standard' (this PR).
    const je = await note(id, '2026-08-20', 1500, 10);
    expect(await journalLegs(f, je)).toEqual([
      L('1100', 0, 1650), L('2120', 150, 0, { vat: 'standard' }),
      L('4000', 200, 0, { vat: 'exempt' }), L('4000', 300, 0, { vat: 'zero_rated' }), L('4000', 1000, 0, { vat: 'standard' }),
    ]);
    expect(await fields('2026-08-01', '2026-08-31')).toEqual([0, 0, 0, 0]);
  });

  it('a 150 + VAT 15.00 note against a mixed invoice debits every line pro rata, and every VAT201 field moves by a tenth', async () => {
    const id = await approvedInvoice('2026-10-10', [
      { description: 'Standard', unitPrice: 1000 }, { description: 'Export', unitPrice: 300 }, { description: 'Exempt', unitPrice: 200 },
    ], { Standard: ['standard', 150], Export: ['zero_rated', 0], Exempt: ['exempt', 0] }, 150);
    expect(await fields('2026-10-01', '2026-10-31')).toEqual([1000, 300, 200, 150]);
    const je = await note(id, '2026-10-20', 150, 10);
    expect(await journalLegs(f, je)).toEqual([
      L('1100', 0, 165), L('2120', 15, 0, { vat: 'standard' }),
      L('4000', 20, 0, { vat: 'exempt' }), L('4000', 30, 0, { vat: 'zero_rated' }), L('4000', 100, 0, { vat: 'standard' }),
    ]);
    expect(await fields('2026-10-01', '2026-10-31')).toEqual([900, 270, 180, 135]);
  });

  it.each([
    ['VAT at the rate on its subtotal (150 + 22.50)', 150, 15,
      /^Credit note \S+ reverses 150\.00 of an invoice with 1500\.00 left, so its VAT must be 15\.00, not 22\.50\. An invoice with a VAT type per line is credited in proportion across its lines\.$/],
    ['more than the invoice has left (1600 + 160)', 1600, 10, /credits 1600\.00, but the invoice has 1500\.00 left to credit/],
  ] as const)('refuses, through the real service and a committed 4xx, a note with %s: nothing moves', async (_l, subtotal, rate, message) => {
    const id = await approvedInvoice('2026-11-10', [
      { description: 'Standard', unitPrice: 1000 }, { description: 'Export', unitPrice: 300 }, { description: 'Exempt', unitPrice: 200 },
    ], { Standard: ['standard', 150], Export: ['zero_rated', 0], Exempt: ['exempt', 0] }, 150);
    // The VAT given as a figure: create now refuses a taxRate that misses the required VAT (creditNoteTypedVat), and this
    // case is approve's refusal of a draft carrying the wrong figure (one made before the writer PR, or by a dispute).
    const cn = await draftNote(id, '2026-11-20', subtotal, rate, Math.round(subtotal * rate) / 100);
    const before = await footprint(cn.id, id, cn.creditNoteNumber);
    const err = await approveCommittingRefusal(cn.id);
    expect((err as { code?: string }).code).toBe('CREDIT_NOTE_VAT_SPLIT_REFUSED');
    expect((err as Error).message).toMatch(message);
    const after = await footprint(cn.id, id, cn.creditNoteNumber);
    expect(after).toEqual(before);
    expect((after.note as Record<string, unknown>[]).map((n) => [n.status, n.gl_journal_entry_id])).toEqual([['draft', null]]);
    expect(after.lines).toEqual([{ n: 0 }]);
    expect(after.allocations).toEqual([{ n: 0 }]);
  });

  it('a full credit of 66.66 standard (VAT 10.00) + 100 exempt is not refused by a rounding cent', async () => {
    const id = await approvedInvoice('2026-12-10', [{ description: 'Standard', unitPrice: 66.66 }, { description: 'Exempt', unitPrice: 100 }],
      { Standard: ['standard', 10], Exempt: ['exempt', 0] }, 10);
    expect(await fields('2026-12-01', '2026-12-31')).toEqual([66.66, 0, 100, 10]);
    const je = await note(id, '2026-12-20', 166.66, 6, 10);
    expect(await journalLegs(f, je)).toEqual([
      L('1100', 0, 176.66), L('2120', 10, 0, { vat: 'standard' }),
      L('4000', 66.66, 0, { vat: 'standard' }), L('4000', 100, 0, { vat: 'exempt' }),
    ]);
    expect(await fields('2026-12-01', '2026-12-31')).toEqual([0, 0, 0, 0]);
  });

  // The remaining VAT is the invoice's VAT less what its LIVE earlier notes reversed. 1000 standard (VAT 150) + 50
  // exempt: a cancelled 105 + 15.00 note and a live 210 + 30.00 note (std 200, exempt 10), so 840 and 120 remain, and
  // the final 840 + 120 clears every leg. A draft (100 + 50) must not count: counted, 70 of VAT would remain and the
  // final note would be refused as 120 instead of 70; the cancelled one counted, it would be refused too (105).
  // The note being approved is itself still a draft when the reader runs (creditNoteApproveService sets its status
  // after posting), so the reader's `cn.id <> note.id` is redundant with `status NOT IN ('draft', ...)`: a text pin.
  // The cancelled note is dated in MARCH, its own month, so May's VAT201 holds without it. Known defect, fixed by a
  // follow-up PR: in the same period a cancelled note's reversal counts alone in fields 2/3 on a typed invoice
  // (reports/vat201NilRatedSupplies cancelled_entries drops the original only). Dated in May it read [-5, 0, 5, 0].
  // The remaining-net and remaining-VAT reads ignore dates, so what this case proves does not change.
  it('the final note reverses what the live earlier notes left; drafts and cancelled notes do not count', async () => {
    const id = await approvedInvoice('2026-05-10', [{ description: 'Standard', unitPrice: 1000 }, { description: 'Exempt', unitPrice: 50 }],
      { Standard: ['standard', 150], Exempt: ['exempt', 0] }, 150);
    const cancelled = await draftNote(id, '2026-03-12', 105, 15, 15);
    await inTx(f.fx, () => approveCreditNote(f.fx.companyId, cancelled.id, f.fx.userId));
    await inTx(f.fx, () => cancelCreditNote(f.fx.companyId, cancelled.id, f.fx.userId));
    const partial = await note(id, '2026-05-15', 210, 15, 30);
    expect(await journalLegs(f, partial)).toEqual([
      L('1100', 0, 240), L('2120', 30, 0, { vat: 'standard' }),
      L('4000', 10, 0, { vat: 'exempt' }), L('4000', 200, 0, { vat: 'standard' }),
    ]);
    await draftNote(id, '2026-05-16', 100, 15, 50); // left a draft
    const final = await note(id, '2026-05-20', 840, 15, 120);
    expect(await journalLegs(f, final)).toEqual([
      L('1100', 0, 960), L('2120', 120, 0, { vat: 'standard' }),
      L('4000', 40, 0, { vat: 'exempt' }), L('4000', 800, 0, { vat: 'standard' }),
    ]);
    expect(await fields('2026-05-01', '2026-05-31')).toEqual([0, 0, 0, 0]);
  });

  // Ten R10.10 standard lines each carry 1.52 (1.515 rounded up): 15.20 on 101.00, above 15% of it (15.15). A note
  // clearing the net carries all of the VAT left, whatever the rate on its subtotal says.
  it('a single full credit of ten R10.10 standard lines (VAT 15.20) posts and returns the VAT201 to zero', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ description: `Line ${i + 1}`, unitPrice: 10.1 }));
    const id = await approvedInvoice('2026-06-10', items,
      Object.fromEntries(items.map((it) => [it.description, ['standard', 1.52] as [string, number]])), 15.2);
    expect(await fields('2026-06-01', '2026-06-30')).toEqual([101, 0, 0, 15.2]);
    const je = await note(id, '2026-06-20', 101, 15, 15.2);
    expect(await journalLegs(f, je)).toEqual([L('1100', 0, 116.2), L('2120', 15.2, 0, { vat: 'standard' }), L('4000', 101, 0, { vat: 'standard' })]);
    expect(await fields('2026-06-01', '2026-06-30')).toEqual([0, 0, 0, 0]);
  });

  // The same invoice credited in two halves: each must carry 7.60 (15.20 x 50.50 / 101.00; the second, clearing the
  // net, all that is left), not the 7.58 the rate gives. 7.58 + 7.58 would strand 0.04 of VAT; 7.60 is required.
  it('ten R10.10 lines credited in two notes of 50.50 + 7.60 post and return the VAT201 to zero', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ description: `Half ${i + 1}`, unitPrice: 10.1 }));
    const id = await approvedInvoice('2026-04-10', items,
      Object.fromEntries(items.map((it) => [it.description, ['standard', 1.52] as [string, number]])), 15.2);
    for (const date of ['2026-04-15', '2026-04-20']) {
      const je = await note(id, date, 50.5, 15, 7.6);
      expect(await journalLegs(f, je)).toEqual([L('1100', 0, 58.1), L('2120', 7.6, 0, { vat: 'standard' }), L('4000', 50.5, 0, { vat: 'standard' })]);
    }
    expect(await fields('2026-04-01', '2026-04-30')).toEqual([0, 0, 0, 0]);
  });

  it('a note against a legacy invoice keeps its uncoded revenue debit, as before', async () => {
    const id = await approvedInvoice('2026-09-10', [{ description: 'A', unitPrice: 1000 }]);
    const je = await note(id, '2026-09-20', 400, 15);
    expect(await journalLegs(f, je)).toEqual([L('1100', 0, 460), L('2120', 60, 0, { vat: 'standard' }), L('4000', 400, 0)]);
  });
});
