// Supplier purchase orders list: the table becomes labelled cards below lg, and every control is 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({}) }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: { total: 1, orders: [{ id: 'po1', order_number: 'PO-1', supplier_name: 'Acme', order_date: '2026-08-01', delivery_date: null, total_amount: 100, status: 'draft' }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/supplier-purchase-orders/index';

afterEach(cleanup);

describe('Supplier purchase orders on touch', () => {
  it('turns the table into labelled cards on phones', async () => {
    const { container } = render(<Page />);
    await screen.findByText('PO-1');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    const labels = [...table.querySelectorAll('tbody tr:first-child td')].map(td => td.getAttribute('data-label'));
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent);
    expect(heads).toHaveLength(7);
    // The last column has no header text; its cell is labelled "Actions" so the card is not left with a bare label.
    expect(labels).toEqual([...heads.slice(0, 6), 'Actions']);
  });

  it('gives every control 44px on phones', async () => {
    const { container } = render(<Page />);
    await screen.findByText('PO-1');
    const controls = [...container.querySelectorAll('button, a, input')];
    expect(controls.length).toBeGreaterThanOrEqual(10); // New PO, 5 tabs, search, PO link, delete, open
    for (const c of controls) expect(c.className, c.textContent || c.getAttribute('title') || c.tagName).toContain('max-lg:min-h-11');
    // The icon-only row actions are also 44px wide, and the search spans the phone.
    expect(screen.getByTitle('Delete draft').className).toContain('max-lg:min-w-11');
    // The 44px link and action cells are centred against their label, not hung from the top of the row.
    for (const l of ['PO #', 'Actions']) expect(container.querySelector(`td[data-label="${l}"]`)!.className).toContain('max-lg:items-center');
    expect(container.querySelector('input')!.className).toContain('max-lg:w-full');
    expect(screen.getByRole('button', { name: /^all$/i }).parentElement!.className).toContain('max-lg:flex-wrap');
  });
});
