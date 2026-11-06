import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CustomerInvoiceTable, type CustomerInvoiceRow } from '@/components/accounting/customer-invoices/CustomerInvoiceTable';

const row = (over: Partial<CustomerInvoiceRow>): CustomerInvoiceRow => ({
  id: 'i1', invoice_number: 'INV-1', project_id: 'p', total_amount: 1500, amount_paid: 0,
  status: 'sent', invoice_date: '2026-10-01', ...over,
});

describe('invoice list amounts', () => {
  it('shows a foreign invoice in its own currency, not as Rand', () => {
    const { container } = render(
      <CustomerInvoiceTable invoices={[row({ currency_code: 'USD' })]} page={1} limit={25} total={1} onPage={() => {}} onOpen={() => {}} />,
    );
    const text = container.querySelector('tbody')!.textContent ?? '';
    expect(text).toMatch(/US\$|USD|\$/);
    expect(text).not.toMatch(/R\s?1[\s ]?500/);
  });
  it('keeps a Rand invoice as Rand', () => {
    const { container } = render(
      <CustomerInvoiceTable invoices={[row({ currency_code: 'ZAR' })]} page={1} limit={25} total={1} onPage={() => {}} onOpen={() => {}} />,
    );
    expect(container.querySelector('tbody')!.textContent).toMatch(/R\s?1[\s ]?500/);
  });
});
