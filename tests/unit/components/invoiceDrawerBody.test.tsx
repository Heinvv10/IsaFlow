/** Master plan U (M10): the invoice drawer reads the detail route and never shows a failed read as an empty invoice. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { InvoiceDrawerBody } from '@/components/accounting/customer-invoices/InvoiceDrawerBody';

useApiJsonOverMock();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const DETAIL = {
  id: 'inv-1', invoice_number: 'INV-001', client_name: 'Acme', status: 'partially_paid', currency_code: 'ZAR',
  invoice_date: '2026-06-01', due_date: '2026-07-01', subtotal: '100.00', tax_amount: '15.00', total_amount: '115.00', amount_paid: '15.00',
  items: [{ id: 'l1', description: 'Fibre install', quantity: '2.00', amount: '100.00' }],
};

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(cleanup);

describe('InvoiceDrawerBody', () => {
  it('asks for this invoice and shows its customer, lines, totals and what is outstanding', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json({ success: true, data: DETAIL }));
    render(<InvoiceDrawerBody invoiceId="inv-1" />);
    expect(await screen.findByText('Fibre install')).toBeTruthy();
    expect(vi.mocked(apiFetch).mock.calls[0]![0]).toBe('/api/accounting/customer-invoices-detail?id=inv-1');
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByTestId('invoice-drawer-outstanding').textContent).toMatch(/100[.,]00/);
    expect(screen.getByRole('link', { name: 'Open invoice' }).getAttribute('href')).toBe('/accounting/customer-invoices/inv-1');
  });

  it('shows a foreign invoice in its own currency', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json({ success: true, data: { ...DETAIL, currency_code: 'USD' } }));
    render(<InvoiceDrawerBody invoiceId="inv-1" />);
    expect((await screen.findByTestId('invoice-drawer-outstanding')).textContent).toContain('$');
  });

  it('shows the server\'s refusal, not an empty invoice', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json({ success: false, error: { code: 'NOT_FOUND', message: 'Invoice not found' } }, 404));
    render(<InvoiceDrawerBody invoiceId="inv-1" />);
    expect(await screen.findByText('Invoice not found')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open invoice' })).toBeNull();
  });
});
