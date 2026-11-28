// Items list: the table becomes labelled cards below lg; Add Item, the search box, both filters, the code links and the empty-state link are 44px; the header wraps.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { name: 'Demo Co' } }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify({ success: true, data: String(url).includes('item-categories') ? [{ id: 'c1', name: 'Cables' }] : state.items }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/items/index';

const item = (id: string, type: 'physical' | 'service') => ({ id, code: `IT-${id}`, description: `Item ${id}`, item_type: type, category_id: 'c1', category_name: 'Cables', selling_price_excl: 100, cost_price: 60, current_qty: 5, is_active: true, unit: 'm' });
afterEach(() => { cleanup(); state.items = []; });
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const HEADS = ['Code', 'Description', 'Type', 'Category', 'Selling Price', 'Cost Price', 'Qty on Hand', 'Active'];

describe('Items list on touch', () => {
  it('turns the table into labelled cards matching its headers; the code cell is the unlabelled heading', async () => {
    state.items = [item('1', 'physical'), item('2', 'service')];
    const { container } = render(<Page />);
    await screen.findByText('IT-1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect([...row.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, ...HEADS.slice(1)]);
    }
  });

  it('Add Item, the search box and both filters are 44px; the search box takes the width; the header wraps', async () => {
    state.items = [item('1', 'physical')];
    render(<Page />);
    await screen.findByText('IT-1');
    expect(cls(screen.getByRole('link', { name: /Add Item/ }))).toContain(MIN);
    const search = screen.getByPlaceholderText('Search items...');
    expect(cls(search)).toEqual(expect.arrayContaining([MIN, 'max-lg:w-full']));
    expect(cls(search.parentElement!)).toContain('max-lg:w-full');
    for (const name of ['Item type', 'Category']) expect(cls(await screen.findByRole('combobox', { name })), name).toContain(MIN);
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('the Active dot is centred against its label on cards, active or not', async () => {
    state.items = [item('1', 'physical'), { ...item('2', 'service'), is_active: false }];
    render(<Page />);
    await screen.findByText('IT-1');
    for (const title of ['Active', 'Inactive']) expect(cls(screen.getByTitle(title)), title).toContain('max-lg:self-center');
  });

  it('the item code links are 44px', async () => {
    state.items = [item('1', 'physical'), item('2', 'service')];
    render(<Page />);
    await screen.findByText('IT-1');
    for (const code of ['IT-1', 'IT-2']) expect(cls(screen.getByRole('link', { name: code })), code).toEqual(expect.arrayContaining([MIN, 'max-lg:inline-flex', 'max-lg:items-center']));
  });

  it('the empty state is a centred card with a 44px link', async () => {
    const { container } = render(<Page />);
    const link = await screen.findByRole('link', { name: 'Add your first item' });
    expect(cls(link)).toEqual(expect.arrayContaining([MIN, 'max-lg:inline-flex', 'max-lg:items-center']));
    expect(cls(link.closest('td')!)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
    expect(container.querySelector('tbody td[data-label]')).toBeNull();
  });

  it('the loading row is centred the same way', () => {
    const { container } = render(<Page />);
    const td = container.querySelector('tbody td')!;
    expect(td.textContent).toContain('Loading');
    expect(cls(td)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
  });
});
