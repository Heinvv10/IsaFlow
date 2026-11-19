/**
 * The invoice PDF and lines carrying their VAT type (migration 1008): each line prints its STORED tax_amount (no
 * re-allocation of the header VAT over the lines) and a short VAT type label, and the totals label states a rate
 * only when the VAT is that rate on the whole subtotal. A legacy invoice prints exactly what it printed before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shown = vi.hoisted(() => ({ table: null as null | { head: unknown; body: unknown }, totals: [] as unknown[] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('jspdf-autotable', async () => {
  const actual = await vi.importActual<typeof import('jspdf-autotable')>('jspdf-autotable');
  return {
    ...actual,
    default: (doc: unknown, opts: { head: unknown; body: unknown }) => {
      shown.table = { head: opts.head, body: opts.body };
      return (actual.default as (d: unknown, o: unknown) => void)(doc, opts);
    },
  };
});
vi.mock('@/modules/accounting/services/core/pdfShared', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/core/pdfShared')>('@/modules/accounting/services/core/pdfShared');
  return {
    ...actual,
    renderTotalsBlock: (...args: Parameters<typeof actual.renderTotalsBlock>) => {
      shown.totals = args[5] as unknown[];
      return actual.renderTotalsBlock(...args);
    },
  };
});

import { generateInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfBuilder';
import type { InvoicePdfModel } from '@/modules/accounting/services/ar/invoicePdfModel';
import { fmtZAR } from '@/modules/accounting/services/core/pdfShared';

/** Money as the PDF prints it (fmtZAR's own spacing). */
const R = (n: number): string => fmtZAR(n);

function model(invoice: Record<string, unknown>, items: Record<string, unknown>[]): InvoicePdfModel {
  return {
    company: { name: 'Issuer', address: '1 Road', phone: '', email: '', vatNumber: '', bankName: '', bankAccountName: 'Issuer',
      bankAccountNumber: '', bankBranchCode: '', logoData: null, primaryColor: '#0f766e' },
    invoice: { invoice_number: 'INV-1', invoice_date: '2026-09-01', due_date: '2026-10-01', status: 'approved', payment_terms: null,
      tax_rate: '15.00', amount_paid: '0', currency_code: 'ZAR', exchange_rate: '1', notes: null, billing_period_start: null,
      billing_period_end: null, project_name: null, client_name: 'Acme', client_address: null, client_contact: null,
      client_email: null, client_phone: null, client_vat: null, client_terms: null, client_terms_immediate: false, ...invoice },
    items,
  } as unknown as InvoicePdfModel;
}
const line = (amount: string, taxRate: string, vatType: string | null = null, taxAmount: string | null = null) =>
  ({ description: `Line ${amount}`, quantity: '1.00', unit_price: amount, amount, tax_rate: taxRate, vat_type: vatType, tax_amount: taxAmount });
const totalsLabels = () => (shown.totals as { label: string; value: string }[]).map((t) => [t.label, t.value]);

describe('the invoice PDF, lines carrying their VAT type', () => {
  beforeEach(() => { shown.table = null; shown.totals = []; });

  it('prints each line\'s stored VAT and its type, and "VAT" for a mixed total', async () => {
    await generateInvoicePdf('co', 'inv', model({ subtotal: '1500.00', tax_amount: '150.00', total_amount: '1650.00' }, [
      line('1000.00', '15.00', 'standard', '150.00'), line('300.00', '0.00', 'zero_rated', '0.00'),
      line('200.00', '0.00', 'exempt', '0.00'),
    ]));
    expect(shown.table!.head).toEqual([['Description', 'Qty', 'Unit Price', 'VAT type', 'VAT', 'Amount']]);
    expect(shown.table!.body).toEqual([
      ['Line 1000.00', '1.00', R(1000.00), 'Standard (15%)', R(150.00), R(1000.00)],
      ['Line 300.00', '1.00', R(300.00), 'Zero-rated (0%)', R(0.00), R(300.00)],
      ['Line 200.00', '1.00', R(200.00), 'Exempt', R(0.00), R(200.00)],
    ]);
    expect(totalsLabels()).toEqual([['Subtotal', R(1500.00)], ['VAT', R(150.00)], ['TOTAL DUE', R(1650.00)]]);
  });

  it('prints the stored VAT of each line, not a re-allocation of the header: seven lines of 14.29 carry 2.14 each', async () => {
    await generateInvoicePdf('co', 'inv', model({ subtotal: '100.03', tax_amount: '14.98', total_amount: '115.01' },
      Array.from({ length: 7 }, () => line('14.29', '15.00', 'standard', '2.14'))));
    expect((shown.table!.body as string[][]).map((r) => r[4])).toEqual(Array(7).fill(R(2.14)));
    expect(totalsLabels()[1]).toEqual(['VAT (15%)', R(14.98)]);
  });

  it('a legacy invoice prints exactly as before: five columns, the header VAT allocated over the lines', async () => {
    await generateInvoicePdf('co', 'inv', model({ subtotal: '100.03', tax_amount: '15.00', total_amount: '115.03' },
      Array.from({ length: 7 }, () => line('14.29', '15.00'))));
    expect(shown.table!.head).toEqual([['Description', 'Qty', 'Unit Price', 'VAT', 'Amount']]);
    expect((shown.table!.body as string[][]).map((r) => r[3])).toEqual(
      [R(2.15), R(2.15), R(2.14), R(2.14), R(2.14), R(2.14), R(2.14)]);
    expect(totalsLabels()).toEqual([['Subtotal', R(100.03)], ['VAT (15%)', R(15.00)], ['TOTAL DUE', R(115.03)]]);
  });

  it('a legacy line from before migration 1008 (no VAT keys at all) prints as before too', async () => {
    await generateInvoicePdf('co', 'inv', model({ subtotal: '100.00', tax_amount: '15.00', total_amount: '115.00' },
      [{ description: 'Line', quantity: '1.00', unit_price: '100.00', amount: '100.00', tax_rate: '15.00' }]));
    expect(shown.table!.body).toEqual([['Line', '1.00', R(100.00), R(15.00), R(100.00)]]);
  });
});
