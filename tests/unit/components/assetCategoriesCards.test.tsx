// Asset categories: the policy table becomes labelled cards below lg; the filter box is full-width and 44px; the header wraps.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/assets/categories';

const row = (id: string, code: string, name: string, group: string | null) => ({ id, name, code, sars_rate: 20, sars_years: 5, description: '', useful_life_years: 5, residual_pct: 0.1, tax_life_years: 5, ias16_group: group, capitalization_threshold: 1000, tax_code: null, depreciation_method: 'straight_line' });
afterEach(() => { cleanup(); state.rows = [row('c1', 'MV', 'Motor vehicles', 'MV'), row('c2', 'FF', 'Furniture and fittings', null)]; });
state.rows = [row('c1', 'MV', 'Motor vehicles', 'MV'), row('c2', 'FF', 'Furniture and fittings', null)];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Code', 'Category', 'IAS 16', 'Policy Life', 'Residual %', 'Tax Life (SARS)', 'SARS Rate', 'Cap Threshold', 'Method'];

describe('Asset categories on touch', () => {
  it('turns the table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Motor vehicles');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const tr of rows) expect([...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('centres the no-match cell in card mode', async () => {
    render(<Page />);
    await screen.findByText('Motor vehicles');
    fireEvent.change(screen.getByPlaceholderText(/Filter by name/), { target: { value: 'zzzz' } });
    const cell = (await screen.findByText('No categories match your filter.')).closest('td')!;
    expect(cls(cell)).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
    expect(cell.hasAttribute('data-label')).toBe(false);
  });

  it('makes the filter box full-width and 44px, and lets the header wrap', async () => {
    render(<Page />);
    await screen.findByText('Motor vehicles');
    const input = screen.getByPlaceholderText(/Filter by name/);
    expect(cls(input)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:w-full']));
    expect(cls(input.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });
});
