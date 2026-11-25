// Asset register report: the register becomes labelled cards below lg; the header wraps so Export CSV drops under the title on a phone.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ assets: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { assets: state.assets, summary: { totalAssets: state.assets.length, totalCost: 100000, totalAccumulatedDepreciation: 30000, totalBookValue: 70000, asOfDate: '2026-11-23' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/assets/register';

const asset = (id: string) => ({ id, asset_number: 'FA-0001', name: 'Delivery van', category: 'vehicles', category_name: 'Vehicles', purchase_date: '2024-02-01', purchase_price: 100000, total_depreciation: 30000, net_book_value: 70000, depreciation_method: 'straight_line', status: 'in_use', sars_rate: 20 });
afterEach(() => { cleanup(); state.assets = [asset('a1'), asset('a2')]; });
state.assets = [asset('a1'), asset('a2')];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Asset #', 'Name', 'Category', 'Purchase Date', 'Cost', 'Accum. Dep.', 'Book Value', 'Status'];

describe('Asset register on touch', () => {
  it('turns the table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findAllByText('FA-0001');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const tr of rows) expect([...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('centres the empty-state cell in card mode', async () => {
    state.assets = [];
    render(<Page />);
    const cell = (await screen.findByText('No assets found for this period')).closest('td')!;
    expect(cls(cell)).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
    expect(cell.hasAttribute('data-label')).toBe(false);
  });

  it('lets the header wrap with a gap so Export CSV drops under the title', async () => {
    render(<Page />);
    await screen.findAllByText('FA-0001');
    const header = screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!;
    expect(cls(header)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });
});
