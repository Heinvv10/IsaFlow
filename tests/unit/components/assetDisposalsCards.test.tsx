// Asset disposals: the register becomes labelled cards below lg (every cell, the asset number included, is a labelled row).
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/assets/disposals';

const row = (id: string, gain: number) => ({ id, asset_number: 'FA-0001', asset_name: 'Delivery van', category: 'Vehicles', disposal_date: '2026-10-01', disposal_method: 'sale', disposal_amount: 80000, book_value_at_disposal: 70000, gain_loss: gain });
afterEach(() => { cleanup(); state.rows = [row('d1', 10000), row('d2', -5000)]; });
state.rows = [row('d1', 10000), row('d2', -5000)];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Asset', 'Name', 'Date', 'Method', 'Sale/Scrap Value', 'Book Value', 'Gain / (Loss)'];

describe('Asset disposals on touch', () => {
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
    state.rows = [];
    render(<Page />);
    const cell = (await screen.findByText('No disposals recorded yet')).closest('td')!;
    expect(cls(cell)).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
    expect(cell.hasAttribute('data-label')).toBe(false);
  });
});
