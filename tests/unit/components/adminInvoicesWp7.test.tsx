/**
 * WP7 (admin audit 2026-11-14 items 1.7-1.9, 2.10, 3.7 for invoices): the admin Invoices page
 *  - sends the date filters as from_date / to_date, the names the API reads (it sent date_from / date_to);
 *  - creates with a blank due date and notes by leaving them out (it sent null, which the API refused), and sends
 *    only the subtotal: VAT and total are the server's, shown here as a preview from the same function;
 *  - asks before Send (emails the customer) and before Mark Paid, and sends nothing on Cancel;
 *  - sends X-Admin-Request on every write.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));

import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import InvoicesPage from '../../../pages/admin/billing/invoices';

void mockedApiFetchModule;
useApiJsonOverMock();

const success = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const INVOICE = { id: 'inv-1', invoice_number: 'INV-WP7-1', company_id: 'c1', company_name: 'Acme', status: 'draft',
  subtotal_cents: 10000, tax_cents: 1500, total_cents: 11500, currency: 'ZAR', due_date: null, paid_at: null,
  payment_method: null, created_at: '2026-01-01T00:00:00Z' };

function serve(items: unknown[], post: (path: string) => unknown = () => ({})) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url).split('?')[0]!;
    if ((init?.method ?? 'GET') === 'GET') return success({ items, total: items.length, page: 1, limit: 25 });
    return success(post(path));
  });
}
const calls = () => vi.mocked(apiFetch).mock.calls.map(([u, i]) => ({ url: String(u), init: (i ?? {}) as RequestInit }));
const posts = (suffix: string) => calls().filter((c) => c.init.method === 'POST' && c.url.split('?')[0]!.endsWith(suffix));

afterEach(() => { cleanup(); });

describe('admin invoices page (WP7)', () => {
  it('sends the date filters as from_date / to_date', { timeout: 15000 }, async () => {
    serve([]);
    render(<InvoicesPage />);
    for (const [label, iso] of [['From date', '2026-03-01'], ['To date', '2026-03-31']] as const) {
      const field = await screen.findByLabelText(label);
      fireEvent.change(field, { target: { value: iso } });
      fireEvent.blur(field);
    }
    await waitFor(() => expect(calls().some((c) => c.url.includes('from_date=2026-03-01') && c.url.includes('to_date=2026-03-31'))).toBe(true),
      { timeout: 5000 });
    expect(calls().some((c) => /date_from|date_to/.test(c.url))).toBe(false);
  });

  it('creates with a blank due date and notes left out, and the subtotal only; previews 15% VAT', async () => {
    serve([], () => ({ id: 'inv-2' }));
    const { container } = render(<InvoicesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /create invoice/i }));
    fireEvent.change(screen.getByLabelText('Company ID'), { target: { value: 'c9' } });
    fireEvent.change(screen.getByLabelText('Subtotal (R)'), { target: { value: '100' } });
    expect(screen.getByTestId('invoice-vat-preview').textContent).toContain(formatCurrency(15));
    expect(screen.getByTestId('invoice-total-preview').textContent).toContain(formatCurrency(115));
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(posts('/api/admin/billing/invoices')).toHaveLength(1));
    const sent = posts('/api/admin/billing/invoices')[0]!;
    expect(JSON.parse(String(sent.init.body))).toEqual({ company_id: 'c9', subtotal_cents: 10000 });
    expect(new Headers(sent.init.headers).get('X-Admin-Request')).toBe('true');
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
  });

  it('Send asks first: Cancel sends nothing; confirming sends once with the admin header', async () => {
    serve([INVOICE], () => ({ sent: true, recipient: 'billing@acme.example.test' }));
    render(<InvoicesPage />);
    fireEvent.click(await screen.findByTitle('Send'));
    expect(await screen.findByText(/billing email/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByText(/billing email/i)).toBeNull();
    expect(posts('/send')).toHaveLength(0);

    fireEvent.click(screen.getByTitle('Send'));
    fireEvent.click(await screen.findByRole('button', { name: /^send invoice$/i }));
    await waitFor(() => expect(posts('/api/admin/billing/invoices/inv-1/send')).toHaveLength(1));
    expect(new Headers(posts('/send')[0]!.init.headers).get('X-Admin-Request')).toBe('true');
    expect(await screen.findByText(/billing@acme\.example\.test/)).toBeTruthy();
  });

  it('Mark Paid asks first: Cancel sends nothing; confirming sends once', async () => {
    serve([{ ...INVOICE, status: 'sent' }], () => ({ paid: true, payment_method: 'manual' }));
    render(<InvoicesPage />);
    fireEvent.click(await screen.findByTitle('Mark Paid'));
    fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));
    expect(posts('/mark-paid')).toHaveLength(0);

    fireEvent.click(screen.getByTitle('Mark Paid'));
    fireEvent.click(await screen.findByRole('button', { name: /^mark as paid$/i }));
    await waitFor(() => expect(posts('/api/admin/billing/invoices/inv-1/mark-paid')).toHaveLength(1));
    expect(JSON.parse(String(posts('/mark-paid')[0]!.init.body))).toEqual({ payment_method: 'manual' });
  });
});
