/**
 * Master plan wave 4, PR PV: an unsaved invoice's PDF prints "PREVIEW: NOT SAVED" (in the number's place and across
 * the page), no invoice number, and the preview's own notes; a stored invoice's PDF prints none of that.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { generateInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfBuilder';
import type { InvoicePdfModel } from '@/modules/accounting/services/ar/invoicePdfModel';
import { PREVIEW_WATERMARK } from '@/modules/accounting/services/ar/invoicePdfPreviewMarks';

const model = (invoiceNumber: string | null) => ({
  company: { name: 'Issuer', address: '', phone: '', email: '', vatNumber: '', bankName: '', bankAccountName: '',
    bankAccountNumber: '', bankBranchCode: '', logoData: null, primaryColor: '#0f766e' },
  invoice: { invoice_number: invoiceNumber, invoice_date: '2026-11-06', due_date: '2026-12-06', status: invoiceNumber ? 'draft' : 'preview',
    payment_terms: null, subtotal: 26.1, tax_rate: 15, tax_amount: 3.92, total_amount: 30.02, amount_paid: 0, currency_code: 'ZAR',
    exchange_rate: 1, notes: null, billing_period_start: null, billing_period_end: null, project_name: null, client_name: 'Acme',
    client_address: null, client_contact: null, client_email: null, client_phone: null, client_vat: null, client_terms: null,
    client_terms_immediate: false },
  items: [{ description: 'Widgets', quantity: 3, unit_price: 8.7, amount: 26.1, tax_rate: 15 }],
}) as unknown as InvoicePdfModel;

async function textOf(pdf: Buffer): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> };
  };
  return (await new PDFParse({ data: pdf }).getText()).text.replace(/\s+/g, ' ');
}

describe('the unsaved preview PDF', () => {
  it('prints the mark twice (header and across the page), the notes, and no number', async () => {
    const text = await textOf(await generateInvoicePdf('co', 'preview', model(null), { notes: ['The job was not recognised.'] }));
    expect(text.split(PREVIEW_WATERMARK).length - 1).toBe(2);
    expect(text).toContain('The job was not recognised.');
    expect(text).toContain('PREVIEW');
    expect(text).toContain('30.02');
    expect(text).not.toMatch(/INV-?\d/);
  });

  it('a stored invoice prints its number and no mark', async () => {
    const text = await textOf(await generateInvoicePdf('co', 'inv', model('INV-0042')));
    expect(text).toContain('INV-0042');
    expect(text).not.toContain(PREVIEW_WATERMARK);
  });
});
