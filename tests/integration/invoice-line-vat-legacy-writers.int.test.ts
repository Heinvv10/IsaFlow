/**
 * Migration 1008 adds no writer: the two most used invoice writers besides the form, quote conversion and the
 * recurring run, still write lines with NULL vat_type / tax_amount and a NULL amounts_are, and the invoice posts the
 * legacy journal (one uncoded default_revenue leg, one 'standard' VAT Output leg of the header tax). The create
 * service's own case is in invoice-line-vat-posting.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createQuote } from '@/modules/accounting/services/ar/quoteService';
import { convertToInvoice } from '@/modules/accounting/services/ar/quoteConvertService';
import { runRecurringInvoice } from '@/modules/accounting/services/ar/recurringInvoiceRun';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { journalLegs, L } from './helpers/lineVatFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

const lineVat = async (invoiceId: string) =>
  (await sql`SELECT vat_type, tax_amount FROM customer_invoice_items WHERE invoice_id = ${invoiceId}::UUID`) as Record<string, unknown>[];
const header = async (invoiceId: string) => ((await sql`
  SELECT amounts_are, gl_journal_entry_id FROM customer_invoices WHERE id = ${invoiceId}::UUID`) as Record<string, unknown>[])[0]!;

describeIfDisposable('legacy invoice writers after migration 1008', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => {
    if (!f) return;
    await sql`DELETE FROM customer_quote_lines WHERE quote_id IN (SELECT id FROM customer_quotes WHERE company_id = ${f.fx.companyId}::UUID)`;
    await sql`UPDATE customer_quotes SET converted_invoice_id = NULL WHERE company_id = ${f.fx.companyId}::UUID`;
    await sql`DELETE FROM customer_quotes WHERE company_id = ${f.fx.companyId}::UUID`;
    await sql`DELETE FROM recurring_invoices WHERE company_id = ${f.fx.companyId}::UUID`;
    await dropLineRevenue(f);
  });

  it('quote conversion writes untyped lines and the invoice posts the legacy journal', async () => {
    const q = await inTx(f.fx, () => createQuote(f.fx.companyId, {
      customerName: 'Quote client', clientId: f.fx.customerId, quoteDate: '2026-07-10',
      lines: [{ description: 'Shoot', quantity: 1, unitPrice: 1000, taxRate: 15 }],
    }, f.fx.userId));
    await sql`UPDATE customer_quotes SET status = 'accepted' WHERE id = ${q.id}::UUID`;
    const out = await inTx(f.fx, () => convertToInvoice(f.fx.companyId, q.id, f.fx.userId));
    const invoiceId = out!.invoiceId;
    expect(await lineVat(invoiceId)).toEqual([{ vat_type: null, tax_amount: null }]);
    expect((await header(invoiceId)).amounts_are).toBeNull();
    await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, invoiceId, f.fx.userId));
    expect(await journalLegs(f, String((await header(invoiceId)).gl_journal_entry_id)))
      .toEqual([L('1100', 1150, 0), L('2120', 0, 150, { vat: 'standard' }), L('4000', 0, 1000)]);
  });

  it('a recurring run writes untyped lines and posts the legacy journal', async () => {
    const ri = ((await sql`
      INSERT INTO recurring_invoices (company_id, template_name, client_id, frequency, next_run_date,
                                      line_items, subtotal, tax_rate, tax_amount, total_amount, created_by)
      VALUES (${f.fx.companyId}::UUID, 'Retainer', ${f.fx.customerId}::UUID, 'monthly', '2026-07-01',
              ${JSON.stringify([{ description: 'Retainer', quantity: 1, unitPrice: 800 }])}::JSONB,
              800, 15, 120, 920, ${f.fx.userId})
      RETURNING id`) as { id: string }[])[0]!.id;
    const run = await inTx(f.fx, () => runRecurringInvoice(f.fx.companyId, ri, f.fx.userId));
    expect(await lineVat(run.invoiceId)).toEqual([{ vat_type: null, tax_amount: null }]);
    expect((await header(run.invoiceId)).amounts_are).toBeNull();
    expect(await journalLegs(f, String((await header(run.invoiceId)).gl_journal_entry_id)))
      .toEqual([L('1100', 920, 0), L('2120', 0, 120, { vat: 'standard' }), L('4000', 0, 800)]);
  });
});
