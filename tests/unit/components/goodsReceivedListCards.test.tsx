// Goods received list: the table becomes labelled cards below lg; New GRN (header and empty state) and the search box are 44px; the search box takes the width; the status cell is one value.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ grns: [] as unknown[] }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.grns }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/goods-received/index';

const grn = (id: string, over: Record<string, unknown> = {}) => ({ id, grn_number: `GRN-${id}`, po_number: `PO-${id}`, supplier_name: `Supplier ${id}`, received_date: '2026-11-18', received_by: 'Thandi', notes: null, status: 'received', cancel_reason: null, ...over });
afterEach(() => { cleanup(); state.grns = []; });
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const HEADS = ['GRN #', 'PO Reference', 'Supplier', 'Received Date', 'Received By', 'Status', 'Notes'];

describe('Goods received list on touch', () => {
  it('turns the table into labelled cards matching its headers; the GRN number is the unlabelled heading', async () => {
    state.grns = [grn('1'), grn('2')];
    const { container } = render(<Page />);
    await screen.findByText('GRN-1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, ...HEADS.slice(1)]);
  });

  it('the status cell is one value: the pill and a cancel reason are wrapped together', async () => {
    state.grns = [grn('1', { status: 'cancelled', cancel_reason: 'Wrong supplier' })];
    const { container } = render(<Page />);
    await screen.findByText('GRN-1');
    const cell = container.querySelector('tbody td[data-label="Status"]')!;
    expect(cell.children).toHaveLength(1);
    expect(cls(cell.children[0]!)).toContain('max-lg:text-right');
    expect(cell.textContent).toContain('Wrong supplier');
  });

  it('New GRN (header) and the search box are 44px; the search box takes the width', async () => {
    state.grns = [grn('1')];
    render(<Page />);
    await screen.findByText('GRN-1');
    expect(cls(screen.getByRole('button', { name: /New GRN/ }))).toContain(MIN);
    const search = screen.getByPlaceholderText('Search GRNs...');
    expect(cls(search)).toEqual(expect.arrayContaining([MIN, 'max-lg:w-full']));
    expect(cls(search.parentElement!)).toContain('max-lg:w-full');
  });

  it('the empty state\'s New GRN button is 44px', async () => {
    render(<Page />);
    await screen.findByText('No goods received notes');
    const buttons = screen.getAllByRole('button', { name: /New GRN/ });
    expect(buttons).toHaveLength(2); // the header's and the empty state's
    for (const b of buttons) expect(cls(b), b.textContent ?? '').toContain(MIN);
  });
});
