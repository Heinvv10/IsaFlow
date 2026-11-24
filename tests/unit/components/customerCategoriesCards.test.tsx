// Customer categories: the table becomes labelled cards below lg, the inline add/edit row too; every icon button is a named 44px square; the header wraps.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.items }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/customer-categories/index';

const cat = (id: string) => ({ id, name: `Category ${id}`, description: `About ${id}`, clientCount: 4 });
afterEach(() => { cleanup(); state.items = []; });
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const SQUARE = [MIN, 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center'];

describe('Customer categories on touch', () => {
  it('turns the table into labelled cards; the name is the heading, the actions the footer', async () => {
    state.items = [cat('1'), cat('2')];
    const { container } = render(<Page />);
    await screen.findByText('Category 1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Name', 'Description', 'Customers', 'Actions']);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, 'Description', 'Customers', null]);
  });

  it('Add Category is 44px and the header wraps', async () => {
    state.items = [cat('1')];
    render(<Page />);
    await screen.findByText('Category 1');
    expect(cls(screen.getByRole('button', { name: /Add Category/ }))).toContain(MIN);
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('the row Edit and Delete buttons are named, 44px squares', async () => {
    state.items = [cat('1')];
    render(<Page />);
    await screen.findByText('Category 1');
    for (const name of ['Edit Category 1', 'Delete Category 1']) expect(cls(screen.getByRole('button', { name })), name).toEqual(expect.arrayContaining(SQUARE));
  });

  it('the inline add row: fields full width and 44px, Save and Cancel named 44px squares, the empty cell hidden on cards', async () => {
    state.items = [cat('1')];
    const { container } = render(<Page />);
    await screen.findByText('Category 1');
    fireEvent.click(screen.getByRole('button', { name: /Add Category/ }));
    for (const ph of ['Category name', 'Description']) expect(cls(screen.getByPlaceholderText(ph)), ph).toContain(MIN);
    for (const name of ['Save category', 'Cancel']) expect(cls(screen.getByRole('button', { name }), ), name).toEqual(expect.arrayContaining(SQUARE));
    const row = screen.getByPlaceholderText('Category name').closest('tr')!;
    expect([...row.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, null, null, null]);
    const spacer = row.querySelectorAll('td')[2]!;
    expect(cls(spacer)).toContain('max-lg:!hidden');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('the loading and empty rows are centred full-width blocks', async () => {
    const { container } = render(<Page />);
    const loading = container.querySelector('tbody td')!;
    expect(loading.textContent).toBe('Loading...');
    expect(cls(loading)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
    const empty = (await screen.findByText('No categories yet')).closest('td')!;
    expect(cls(empty)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
  });
});
