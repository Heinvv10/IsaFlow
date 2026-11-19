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
import { inTx, runOn } from './helpers/l1FifoFixture';
import { sql } from '@/lib/neon';
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
  invoice: await sql`SELECT status, amount_paid FROM customer_invoices WHERE id = ${invoiceId}::UUID`,
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
    // The note's own VAT leg stays 'standard' (this PR), carrying the invoice's 150 of VAT: 10% of 1500.
    const je = await note(id, '2026-08-20', 1500, 10);
    expect(await journalLegs(f, je)).toEqual([
      L('1100', 0, 1650), L('2120', 150, 0, { vat: 'standard' }),
      L('4000', 200, 0, { vat: 'exempt' }), L('4000', 300, 0, { vat: 'zero_rated' }), L('4000', 1000, 0, { vat: 'standard' }),
    ]);
    expect(await fields('2026-08-01', '2026-08-31')).toEqual([0, 0, 0, 0]);
  });

  it('a 200 + VAT 30 note against a mixed invoice debits standard 200 only, and the VAT201 moves consistently', async () => {
    const id = await approvedInvoice('2026-10-10', [
      { description: 'Standard', unitPrice: 1000 }, { description: 'Export', unitPrice: 300 }, { description: 'Exempt', unitPrice: 200 },
    ], { Standard: ['standard', 150], Export: ['zero_rated', 0], Exempt: ['exempt', 0] }, 150);
    expect(await fields('2026-10-01', '2026-10-31')).toEqual([1000, 300, 200, 150]);
    const je = await note(id, '2026-10-20', 200, 15);
    expect(await journalLegs(f, je)).toEqual([
      L('1100', 0, 230), L('2120', 30, 0, { vat: 'standard' }), L('4000', 200, 0, { vat: 'standard' }),
    ]);
    // field 1 -200, output VAT -30, fields 2 and 3 unchanged.
    expect(await fields('2026-10-01', '2026-10-31')).toEqual([800, 300, 200, 120]);
  });

  it.each([
    ['more rated net than the rated legs carry (1100 + 165 against 1000 standard)', 1100, 15, /1100\.00 of standard-rated supplies/],
    ['VAT above the rate on its subtotal (100 + 30)', 100, 30, /its VAT of 30\.00 is more than 15% of its subtotal of 100\.00/],
  ] as const)('refuses, through the real service and a committed 4xx, a note with %s: nothing moves', async (_l, subtotal, rate, message) => {
    const id = await approvedInvoice('2026-11-10', [
      { description: 'Standard', unitPrice: 1000 }, { description: 'Export', unitPrice: 300 }, { description: 'Exempt', unitPrice: 200 },
    ], { Standard: ['standard', 150], Export: ['zero_rated', 0], Exempt: ['exempt', 0] }, 150);
    const cn = await draftNote(id, '2026-11-20', subtotal, rate);
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

  it('a note against a legacy invoice keeps its uncoded revenue debit, as before', async () => {
    const id = await approvedInvoice('2026-09-10', [{ description: 'A', unitPrice: 1000 }]);
    const je = await note(id, '2026-09-20', 400, 15);
    expect(await journalLegs(f, je)).toEqual([L('1100', 0, 460), L('2120', 60, 0, { vat: 'standard' }), L('4000', 400, 0)]);
  });
});
