/**
 * Per-line VAT writer PR: on an inclusive invoice the stored unit_price is VAT-inclusive as entered and each line's
 * amount is its NET, so every screen that shows the two side by side says which is which: the invoice detail page
 * (CustomerInvoiceSummary), the customer portal and the preview modal. An exclusive invoice reads as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('@/modules/accounting/services/ar/portalInvoiceService', () => ({ loadPortalInvoice: vi.fn() }));

import { CustomerInvoiceSummary } from '@/components/invoices/CustomerInvoiceSummary';
import PortalInvoicePage from '../../../pages/portal/invoice/[token]';

const item = { id: 'l1', description: 'Ten', quantity: 100, unit_price: 9.99, amount: 868.7, tax_rate: 15 };
const summary = (amountsAre: string | null) => render(<CustomerInvoiceSummary invoiceDate="2026-11-20" dueDate="2026-12-20"
  billingPeriodStart="" billingPeriodEnd="" taxRate={15} subtotal={868.7} taxAmount={130.3} totalAmount={999} balance={999}
  notes="" items={[item]} amountsAre={amountsAre} />);

describe('the invoice detail page', () => {
  it('an inclusive invoice heads the price incl. VAT and the amount excl. VAT', () => {
    summary('inclusive');
    expect(screen.getByRole('columnheader', { name: 'Unit Price (incl. VAT)' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Amount (excl. VAT)' })).toBeTruthy();
  });
  it.each([null, 'exclusive'])('%s reads as before', (v) => {
    summary(v);
    expect(screen.getByRole('columnheader', { name: 'Unit Price' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Amount' })).toBeTruthy();
  });
});

describe('the customer portal', () => {
  const invoice = (amountsAre: string | null) => ({
    invoice_number: 'INV-1', invoice_date: '2026-11-20', due_date: '2099-01-01', status: 'sent', currency_code: 'ZAR',
    subtotal: 868.7, tax_amount: 130.3, total_amount: 999, amount_paid: 0, amounts_are: amountsAre, notes: null,
    customer_name: 'Acme', company_name: 'Issuer', company_logo_url: null, portal_display_name: null, portal_primary_color: null,
    portal_allow_payments: false, portal_payment_instructions: null, items: [item],
  });
  it('an inclusive invoice heads the price incl. VAT and the amount excl. VAT', () => {
    render(<PortalInvoicePage invoice={invoice('inclusive')} token={'a'.repeat(64)} isOverdue={false} />);
    expect(screen.getByRole('columnheader', { name: 'Unit Price (incl. VAT)' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Amount (excl. VAT)' })).toBeTruthy();
  });
  it('an exclusive one reads as before', () => {
    render(<PortalInvoicePage invoice={invoice(null)} token={'a'.repeat(64)} isOverdue={false} />);
    expect(screen.getByRole('columnheader', { name: 'Unit Price' })).toBeTruthy();
  });
});
