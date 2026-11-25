// Item opening balances: the table becomes labelled cards below lg; the quantity and cost inputs, search and Save are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: [{ id: 'i1', item_code: 'WID-1', name: 'Widget', category: 'Parts', uom: 'ea', quantity_on_hand: 10, cost_price: 5 }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/item-opening-balances';

afterEach(cleanup);
const HEADS = ['Code', 'Item', 'UOM', 'Quantity', 'Unit Cost', 'Total Value'];

describe('Item opening balances on touch', () => {
  it('turns the table into labelled cards whose labels equal the headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Widget');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const row = table.querySelector(':scope > tbody > tr')!;
    expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('makes both inputs 44px and shrinkable beside their labels, centred in their rows', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Widget');
    const inputs = [...container.querySelectorAll('tbody input')];
    expect(inputs).toHaveLength(2); // quantity, unit cost
    for (const i of inputs) {
      for (const c of ['max-lg:min-h-11', 'max-lg:w-auto', 'max-lg:min-w-0', 'max-lg:flex-1']) expect(i.className.split(' '), c).toContain(c);
      expect(i.closest('td')!.className).toContain('max-lg:items-center');
    }
  });

  it('makes the search and Save 44px, and the header and its total/save group wrap', async () => {
    render(<Page />);
    await screen.findByText('Widget');
    expect(screen.getByPlaceholderText('Search items...').className).toContain('max-lg:min-h-11');
    const save = screen.getByRole('button', { name: /^Save/ });
    expect(save.className).toContain('max-lg:min-h-11');
    expect(save.parentElement!.className).toContain('max-lg:flex-wrap');
    const row = screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!;
    expect(row.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });
});
