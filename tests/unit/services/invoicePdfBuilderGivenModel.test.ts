/**
 * PR S round seventeen: generateInvoicePdf renders a model it is given (the approval's, compared under its row lock)
 * as it is, and never re-reads one; without it, it loads the model itself.
 */
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/invoicePdfModel', () => ({ loadInvoicePdfModel: m.load }));

import { generateInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfBuilder';
import type { InvoicePdfModel } from '@/modules/accounting/services/ar/invoicePdfModel';

const MODEL = {
  company: { name: 'Issuer', address: '1 Road', phone: '', email: '', vatNumber: '', bankName: 'Seen Bank', bankAccountName: 'Issuer',
    bankAccountNumber: '1111111111', bankBranchCode: '250655', logoData: null, primaryColor: '#0f766e' },
  invoice: { invoice_number: 'INV-1', invoice_date: '2026-09-01', due_date: '2026-10-01', status: 'approved', payment_terms: null,
    subtotal: '100.00', tax_rate: '15.00', tax_amount: '15.00', total_amount: '115.00', amount_paid: '0', currency_code: 'ZAR',
    exchange_rate: '1', notes: null, billing_period_start: null, billing_period_end: null, project_name: null, client_name: 'Acme',
    client_address: null, client_contact: null, client_email: null, client_phone: null, client_vat: null },
  items: [{ description: 'Line', quantity: '1.00', unit_price: '100.00', amount: '100.00', tax_rate: '15.00' }],
} as unknown as InvoicePdfModel;

describe('generateInvoicePdf and a given model', () => {
  it('renders the given model and reads none', async () => {
    const pdf = await generateInvoicePdf('co', 'inv', MODEL);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(m.load).not.toHaveBeenCalled();
  });

  it('without one, loads it', async () => {
    m.load.mockResolvedValueOnce(MODEL);
    await generateInvoicePdf('co', 'inv');
    expect(m.load).toHaveBeenCalledWith('co', 'inv');
  });
});
