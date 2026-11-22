// Purchase orders list (/accounting/purchase-orders; the old supplier-purchase-orders URL redirects here):
// the table becomes labelled cards below lg, and every control is 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: [{ id: 'po1', po_number: 'PO-1', supplier_name: 'Acme', order_date: '2026-08-01', expected_delivery_date: '2026-09-01', status: 'approved', subtotal: 100, tax_amount: 15, total: 115 }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/purchase-orders/index';

afterEach(cleanup);

describe('Purchase orders list on touch', () => {
  it('turns the table into labelled cards on phones', async () => {
    const { container } = render(<Page />);
    await screen.findByText('PO-1');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    const labels = [...table.querySelectorAll('tbody tr:first-child td')].map(td => td.getAttribute('data-label'));
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent);
    expect(heads).toHaveLength(6);
    expect(labels).toEqual(heads);
  });

  it('gives every control 44px on phones', async () => {
    const { container } = render(<Page />);
    await screen.findByText('PO-1');
    const controls = [...container.querySelectorAll('button, a, input')];
    expect(controls.length).toBeGreaterThanOrEqual(12); // Export, New PO, 8 tabs, search, PO link
    for (const c of controls) expect(c.className, c.textContent || c.tagName).toContain('max-lg:min-h-11');
    // The 44px link is centred against its label, not hung from the top of the row.
    expect(container.querySelector('td[data-label="PO #"]')!.className).toContain('max-lg:items-center');
    expect(container.querySelector('input')!.className).toContain('max-lg:w-full');
    expect(screen.getByRole('button', { name: /^all$/i }).parentElement!.className.split(' ')).toContain('flex-wrap'); // eight tabs wrap at every width
  });
});
