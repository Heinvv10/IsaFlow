// Below-threshold assets: the list becomes labelled cards below lg; Post to GL is 44px and its cell hides once an asset is expensed.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/assets/below-threshold';

const row = (id: string, num: string, expensed: boolean) => ({ id, asset_number: num, name: 'Office chair', category_name: 'Furniture', cost: 900, threshold: 1000, expensed });
afterEach(() => { cleanup(); state.rows = [row('a1', 'FA-0001', false), row('a2', 'FA-0002', true)]; });
state.rows = [row('a1', 'FA-0001', false), row('a2', 'FA-0002', true)];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Asset #', 'Name', 'Category', 'Cost', 'Threshold', 'Gap', 'Status', 'Action'];

describe('Below-threshold assets on touch', () => {
  it('turns the table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('FA-0001');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const tr of rows) expect([...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('Post to GL is 44px; the Action cell hides when the asset is already expensed (it would be an empty row)', async () => {
    const { container } = render(<Page />);
    await screen.findByText('FA-0001');
    expect(cls(screen.getByRole('button', { name: /Post to GL/ }))).toEqual(expect.arrayContaining(['max-lg:min-h-11']));
    const [pending, expensed] = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td:last-child')!);
    expect(pending.className).toBe('px-4 py-3'); // desktop classes exactly as before for a pending asset
    expect(cls(expensed)).toContain('max-lg:!hidden');
    expect(expensed.childNodes).toHaveLength(0);
  });

  it('centres the empty-state cell in card mode', async () => {
    state.rows = [];
    render(<Page />);
    const cell = (await screen.findByText(/No assets below the capitalization threshold/)).closest('td')!;
    expect(cls(cell)).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
    expect(cell.hasAttribute('data-label')).toBe(false);
  });
});
