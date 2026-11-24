// Delivery notes list: the table becomes labelled cards below lg; New, the status tabs, Dispatch/Delivered/Cancel and the empty-state button are 44px; the actions cell hides when a note has none.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ notes: [] as unknown[] }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { notes: state.notes, total: state.notes.length } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/delivery-notes/index';

const note = (id: string, status: string) => ({ id, deliveryNoteNumber: `DN-${id}`, customerName: `Customer ${id}`, deliveryDate: '2026-11-18', status, lineCount: 3 });
afterEach(() => { cleanup(); state.notes = []; });
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const FLEX = [MIN, 'max-lg:inline-flex', 'max-lg:items-center'];
const HEADS = ['DN #', 'Customer', 'Date', 'Lines', 'Status', ''];

describe('Delivery notes list on touch', () => {
  it('turns the table into labelled cards matching its headers; the DN number and actions cells are unlabelled', async () => {
    state.notes = [note('1', 'draft'), note('2', 'delivered')];
    const { container } = render(<Page />);
    await screen.findByText('DN-1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    for (const row of table.querySelectorAll('tbody tr')) {
      expect([...row.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, 'Customer', 'Date', 'Lines', 'Status', null]);
    }
  });

  it('the actions cell is hidden on cards when the note has no actions (delivered, cancelled), and kept for draft and dispatched', async () => {
    state.notes = [note('1', 'draft'), note('2', 'dispatched'), note('3', 'delivered'), note('4', 'cancelled')];
    const { container } = render(<Page />);
    await screen.findByText('DN-1');
    const last = [...container.querySelectorAll('tbody tr')].map((r) => r.querySelector('td:last-child')!);
    expect(last.map((td) => cls(td).includes('max-lg:!hidden'))).toEqual([false, false, true, true]);
    expect(last[0]!.className).toBe('px-4 py-3.5');
  });

  it('New Delivery Note, the status tabs and the row actions are 44px', async () => {
    state.notes = [note('1', 'draft'), note('2', 'dispatched')];
    render(<Page />);
    await screen.findByText('DN-1');
    expect(cls(screen.getByRole('button', { name: /New Delivery Note/ }))).toContain(MIN);
    for (const name of ['All', 'Draft', 'Dispatched']) expect(cls(screen.getByRole('button', { name, exact: true })), name).toContain(MIN);
    expect(cls(screen.getAllByRole('button', { name: 'Delivered' })[0]!)).toContain(MIN); // the tab (the row action is checked below by its title)
    expect(cls(screen.getByTitle('Mark Dispatched'))).toContain(MIN);
    for (const b of screen.getAllByTitle('Cancel')) expect(cls(b)).toEqual(expect.arrayContaining([MIN, 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:justify-center']));
    expect(cls(screen.getByTitle('Mark Delivered'))).toContain(MIN);
  });

  it('the tab strip wraps instead of overflowing', async () => {
    state.notes = [note('1', 'draft')];
    render(<Page />);
    await screen.findByText('DN-1');
    expect(cls(screen.getByRole('button', { name: 'All' }).parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:w-full']));
  });

  it('the empty state\'s New Delivery Note button is 44px', async () => {
    render(<Page />);
    await screen.findByText('No delivery notes found'); // past the loading spinner
    const buttons = screen.getAllByRole('button', { name: 'New Delivery Note' });
    expect(buttons).toHaveLength(2); // the header's and the empty state's
    for (const b of buttons) expect(cls(b)).toContain(MIN);
  });
});
