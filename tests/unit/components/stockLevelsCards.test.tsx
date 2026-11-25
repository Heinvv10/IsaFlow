// Stock levels: the table becomes labelled cards below lg; the below-reorder filter is a 44px tap target; the header wraps; the in-stock cell (icon + quantity) is one value.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { items: state.items, summary: { totalProducts: state.items.length, totalStockValue: 1000, belowReorder: 1 } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/stock-levels/index';

const item = (id: string, over: Record<string, unknown> = {}) => ({ id, code: `SKU-${id}`, name: `Product ${id}`, category: 'Cables', current_stock: 20, reorder_level: 5, avg_cost: 100, selling_price: 150, unit: 'm', stock_value: 2000, ...over });
afterEach(() => { cleanup(); state.items = []; });
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Code', 'Product', 'Category', 'In Stock', 'Reorder At', 'Avg Cost', 'Stock Value'];

describe('Stock levels on touch', () => {
  it('turns the table into labelled cards matching its headers; the code is the heading', async () => {
    state.items = [item('1'), item('2')];
    const { container } = render(<Page />);
    await screen.findByText('SKU-1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, ...HEADS.slice(1)]);
  });

  it('the In Stock cell is one value: the below-reorder warning icon and the quantity are wrapped together', async () => {
    state.items = [item('1', { current_stock: 2, reorder_level: 5 })];
    const { container } = render(<Page />);
    await screen.findByText('SKU-1');
    const cell = container.querySelector('tbody td[data-label="In Stock"]')!;
    expect(cell.children).toHaveLength(1);
    expect(cls(cell.children[0]!)).toContain('max-lg:text-right');
    expect(cell.querySelector('svg')).not.toBeNull();
  });

  it('the below-reorder filter row is a 44px tap target, and the header wraps', async () => {
    state.items = [item('1')];
    render(<Page />);
    await screen.findByText('SKU-1');
    const label = screen.getByText('Show only below reorder level').closest('label')!;
    expect(cls(label)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('the loading and empty rows are centred full-width blocks', async () => {
    const { container } = render(<Page />);
    const loading = container.querySelector('tbody td')!;
    expect(loading.textContent).toContain('Loading');
    expect(cls(loading)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
    const empty = (await screen.findByText('No inventory items')).closest('td')!;
    expect(cls(empty)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
  });
});
