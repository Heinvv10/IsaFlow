// Item pricing: the table becomes labelled cards below lg; the price input, search and Save are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: [{ id: 'i1', item_code: 'WID-1', name: 'Widget', category: 'Parts', uom: 'ea', selling_price: 150, cost_price: 100 }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/item-pricing';

afterEach(cleanup);
const HEADS = ['Code', 'Item', 'Category', 'Cost Price', 'Selling Price', 'Margin'];

describe('Item pricing on touch', () => {
  it('turns the table into labelled cards whose labels equal the headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Widget');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const row = table.querySelector(':scope > tbody > tr')!;
    expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('makes the price input, search and Save 44px, and the header wraps', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Widget');
    const price = container.querySelector('tbody input')!;
    expect(price.className).toContain('max-lg:min-h-11');
    // Fixed w-32 beside the label overflowed a 320px card; on phones the input must be allowed to shrink.
    for (const c of ['max-lg:w-auto', 'max-lg:min-w-0', 'max-lg:flex-1']) expect(price.className.split(' ')).toContain(c);
    expect(price.closest('td')!.className).toContain('max-lg:items-center'); // centred against its label
    expect(screen.getByPlaceholderText('Search items...').className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('button', { name: /^Save/ }).className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!.className).toContain('max-lg:flex-wrap');
  });
});
