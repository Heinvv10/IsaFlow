// Batch payments list: the table becomes labelled cards below lg; New Batch, the batch links and the Approve/Process icon buttons are 44px; the actions cell hides when a batch has none.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ items: [] as unknown[], fail: false }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => (state.fail
    ? new Response(JSON.stringify({ success: false, message: 'down' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify({ success: true, data: { items: state.items } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))),
}));

import Page from '../../../pages/accounting/batch-payments/index';

const batch = (id: string, status: string) => ({ id, batchNumber: `BP-${id}`, batchDate: '2026-11-18', totalAmount: 5000, paymentCount: 4, paymentMethod: 'eft', status });
afterEach(() => { cleanup(); state.items = []; state.fail = false; });
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const HEADS = ['Batch Number', 'Date', 'Payments', 'Total', 'Method', 'Status', 'Actions'];

describe('Batch payments list on touch', () => {
  it('turns the table into labelled cards matching its headers; the batch number and actions cells are the unlabelled heading and footer', async () => {
    state.items = [batch('1', 'draft'), batch('2', 'processed')];
    const { container } = render(<Page />);
    await screen.findByText('BP-1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect([...row.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, 'Date', 'Payments', 'Total', 'Method', 'Status', null]);
  });

  it('the actions cell is hidden on cards exactly when it holds no button (processed, cancelled); draft and approved keep it', async () => {
    state.items = [batch('1', 'draft'), batch('2', 'approved'), batch('3', 'processed'), batch('4', 'cancelled')];
    const { container } = render(<Page />);
    await screen.findByText('BP-1');
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(4);
    const last = rows.map((r) => r.querySelector('td:last-child')!);
    expect(last.map((td) => cls(td).includes('max-lg:!hidden'))).toEqual([false, false, true, true]);
    expect(last[0]!.className).toBe('px-4 py-3');
    for (const td of last) expect(td.querySelectorAll('button').length > 0, td.parentElement!.textContent ?? '').toBe(!cls(td).includes('max-lg:!hidden'));
  });

  it('New Batch, the batch number links and the Approve / Process buttons are 44px', async () => {
    state.items = [batch('1', 'draft'), batch('2', 'approved')];
    render(<Page />);
    await screen.findByText('BP-1');
    expect(cls(screen.getByRole('link', { name: /New Batch/ }))).toContain(MIN);
    for (const code of ['BP-1', 'BP-2']) expect(cls(screen.getByRole('link', { name: code })), code).toEqual(expect.arrayContaining([MIN, 'max-lg:inline-flex', 'max-lg:items-center']));
    for (const title of ['Approve', 'Process']) expect(cls(screen.getByRole('button', { name: title })), title).toEqual(expect.arrayContaining([MIN, 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']));
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('the loading row is centred the same way', () => {
    const { container } = render(<Page />);
    const td = container.querySelector('tbody td')!;
    expect(td.textContent).toBe('Loading...');
    expect(cls(td)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
  });

  it('the empty and error rows are centred full-width blocks', async () => {
    const { container, unmount } = render(<Page />);
    const empty = (await screen.findByText('No batch payments')).closest('td')!;
    expect(cls(empty)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
    expect(container.querySelector('tbody td[data-label]')).toBeNull();
    unmount(); cleanup();
    state.fail = true;
    render(<Page />);
    const err = (await screen.findByText(/down|Could not load batch payments/)).closest('td')!;
    expect(cls(err)).toEqual(expect.arrayContaining(['max-lg:!py-3', 'max-lg:!text-center']));
  });
});
