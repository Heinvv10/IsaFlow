// Customer quotes and sales orders lists: cards below lg (data-label), 44px actions.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/x' }),
}));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import CustomerQuotesPage from '../../../pages/accounting/customer-quotes/index';
import CustomerSalesOrdersPage from '../../../pages/accounting/customer-sales-orders/index';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const quote = (id: string, status: string) => ({ id, quoteNumber: `Q-${id}`, customerName: 'Acme', quoteDate: '2026-11-01', expiryDate: '2026-12-01', total: 100, status, invoiceId: null });
const order = (id: string, status: string) => ({ id, orderNumber: `SO-${id}`, customerName: 'Acme', orderDate: '2026-11-01', deliveryDate: null, totalAmount: 100, status });

beforeEach(() => vi.mocked(apiFetch).mockReset());
afterEach(cleanup);

describe('quotes list on touch', () => {
  it('is a card table and its row actions are 44px', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      String(url).includes('customer-quotes') ? ok({ quotes: [quote('1', 'draft'), quote('2', 'sent'), quote('3', 'accepted')], total: 3 }) : ok({ customers: [] }));
    const { container } = render(<CustomerQuotesPage />);
    await screen.findByText('Q-1');
    expect(container.querySelector('table')?.className).toContain('table-cards');
    expect([...container.querySelectorAll('tbody tr:first-child td[data-label]')].map(td => td.getAttribute('data-label')))
      .toEqual(['Quote #', 'Customer', 'Date', 'Expiry', 'Total', 'Status']);
    for (const name of [/Download PDF Q-1/, /Mark Q-1 sent/, /Accept quote Q-2/, /Decline quote Q-2/]) {
      const el = screen.getByLabelText(name);
      for (const c of ['max-lg:h-11', 'max-lg:w-11', 'max-lg:inline-flex']) expect(el.className).toContain(c);
    }
    for (const el of screen.getAllByRole('button', { name: /Invoice|To SO/ })) expect(el.className).toContain('max-lg:min-h-11');
    for (const el of screen.getAllByRole('button', { name: /^(all|draft|sent)$/ })) expect(el.className).toContain('max-lg:min-h-11');
  });
});

describe('sales orders list on touch', () => {
  it('is a card table and edit/delete are 44px', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      String(url).includes('customer-sales-orders') ? ok({ orders: [order('1', 'draft'), order('2', 'confirmed')], total: 2 }) : ok({ data: [] }));
    const { container } = render(<CustomerSalesOrdersPage />);
    await screen.findByText('SO-1');
    expect(container.querySelector('table')?.className).toContain('table-cards');
    expect([...container.querySelectorAll('tbody tr:first-child td[data-label]')].map(td => td.getAttribute('data-label')))
      .toEqual(['Order #', 'Customer', 'Date', 'Delivery Date', 'Total', 'Status']);
    // A non-draft order has no actions, so its empty actions cell is hidden on cards.
    const lastCell = (i: number) => container.querySelectorAll('tbody tr')[i].querySelector('td:last-child');
    expect(lastCell(1)?.className).toContain('max-lg:!hidden');
    expect(lastCell(0)?.className).not.toContain('max-lg:!hidden');
    for (const n of ['Edit sales order SO-1', 'Delete sales order SO-1']) {
      for (const c of ['max-lg:h-11', 'max-lg:w-11', 'max-lg:inline-flex']) expect(screen.getByLabelText(n).className).toContain(c);
    }
  });
});
