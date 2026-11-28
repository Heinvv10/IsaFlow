// Business units: the table becomes labelled cards below lg; New, the search box, the form fields and buttons, and the three row icon buttons are 44px; the search takes the width; the header wraps.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.items }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/business-units/index';

const bu = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Unit ${id}`, code: `BU${id}`, description: 'Build crews', division: 'Delivery', isActive: true, staffCount: 12, ...over });
afterEach(() => { cleanup(); state.items = []; });
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const SQUARE = [MIN, 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center'];
const HEADS = ['Code', 'Name', 'Division', 'Description', 'Staff', 'Status', 'Actions'];

describe('Business units on touch', () => {
  it('turns the table into labelled cards matching its headers; the code is the heading, the actions the footer', async () => {
    state.items = [bu('1'), bu('2')];
    const { container } = render(<Page />);
    await screen.findByText('BU1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, 'Name', 'Division', 'Description', 'Staff', 'Status', null]);
  });

  it('New Business Unit and the search box are 44px; the search takes the width and wraps its row; the header wraps', async () => {
    state.items = [bu('1')];
    render(<Page />);
    await screen.findByText('BU1');
    expect(cls(screen.getByRole('button', { name: /New Business Unit/ }))).toContain(MIN);
    const search = screen.getByPlaceholderText('Search name or code...');
    expect(cls(search)).toEqual(expect.arrayContaining([MIN, 'max-lg:w-full']));
    expect(cls(search.parentElement!)).toContain('max-lg:flex-wrap');
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('the row Edit, Disable and Delete icon buttons are 44px squares (their title names them)', async () => {
    state.items = [bu('1')];
    render(<Page />);
    await screen.findByText('BU1');
    for (const title of ['Edit', 'Disable', 'Delete']) expect(cls(screen.getByTitle(title)), title).toEqual(expect.arrayContaining(SQUARE));
  });

  it('the new-unit form: all four fields and Cancel / Create are 44px', async () => {
    state.items = [bu('1')];
    const { container } = render(<Page />);
    await screen.findByText('BU1');
    fireEvent.click(screen.getByRole('button', { name: /New Business Unit/ }));
    const fields = [...container.querySelectorAll('form input')];
    expect(fields).toHaveLength(4);
    for (const f of fields) expect(cls(f), f.getAttribute('placeholder') ?? '').toContain(MIN);
    for (const name of ['Cancel', 'Create']) expect(cls(screen.getByRole('button', { name })), name).toContain(MIN);
  });

  it('the loading and empty rows are centred full-width blocks', async () => {
    const { container } = render(<Page />);
    const loading = container.querySelector('tbody td')!;
    expect(loading.textContent).toContain('Loading');
    expect(cls(loading)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
    const empty = (await screen.findByText('No business units yet.')).closest('td')!;
    expect(cls(empty)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
  });
});
