// Cost centres: the table becomes labelled cards below lg; tabs, search, form, row actions and header are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: { items: [
      { id: 'c1', code: 'CC-001', name: 'Acme Farms', ccType: 'cc1', isActive: true, department: 'Ops', aliases: ['Acme'] },
      { id: 'c2', code: 'PR-001', name: 'Irrigation', ccType: 'cc2', isActive: true, parentId: 'c1', parentCode: 'CC-001', fnoCode: 'FNO-1' },
    ] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/cost-centres/index';

afterEach(cleanup);
const min = (el: Element, name: string) => expect(el.className, name).toContain('max-lg:min-h-11');
const labels = (row: Element) => [...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'));

describe('Cost centres on touch', () => {
  it('turns the CC1 table into labelled cards; the actions cell has no label', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Acme Farms');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(['Code', 'Name', 'Aliases', 'Department', 'Status', 'Actions']);
    expect(labels(table.querySelector(':scope > tbody > tr')!)).toEqual(['Code', 'Name', 'Aliases', 'Department', 'Status', null]);
  });

  it('labels the CC2 columns too, including Parent and FNO', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Acme Farms');
    fireEvent.click(screen.getByRole('button', { name: /^CC2/ }));
    await screen.findByText('Irrigation');
    const table = container.querySelector('table')!;
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(['Code', 'Name', 'Parent', 'FNO', 'Aliases', 'Department', 'Status', 'Actions']);
    expect(labels(table.querySelector(':scope > tbody > tr')!)).toEqual(['Code', 'Name', 'Parent', 'FNO', 'Aliases', 'Department', 'Status', null]);
  });

  it('makes the header, tabs, search and the three row actions phone-sized', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Acme Farms');
    expect(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!.className).toContain('max-lg:flex-wrap');
    min(screen.getByRole('button', { name: /^New/ }), 'New');
    for (const tab of [/^CC1/, /^CC2/]) min(screen.getByRole('button', { name: tab }), String(tab));
    const search = screen.getByPlaceholderText(/Search code/);
    for (const c of ['max-lg:min-h-11', 'max-lg:w-full']) expect(search.className.split(' '), c).toContain(c);
    expect(search.parentElement!.className).toContain('max-lg:flex-wrap');
    for (const title of ['Edit', 'Disable', 'Delete']) {
      const b = screen.getByTitle(title);
      for (const c of ['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']) expect(b.className, title).toContain(c);
    }
    expect(container.querySelector('tbody tr td:last-child > div')!.className).toContain('max-lg:gap-2');
  });

  it('makes every field and button of the form 44px', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Acme Farms');
    fireEvent.click(screen.getByRole('button', { name: /^New/ }));
    const form = container.querySelector('form')!;
    const controls = [...form.querySelectorAll('input, select, button')];
    expect(controls).toHaveLength(7); // code, name, department, description, aliases, cancel, create
    for (const c of controls) expect(c.className, c.outerHTML.slice(0, 60)).toContain('max-lg:min-h-11');
    fireEvent.click(screen.getByRole('button', { name: /^CC2/ }));
    fireEvent.click(screen.getByRole('button', { name: /^New/ }));
    expect(screen.getByLabelText('Parent').className).toContain('max-lg:min-h-11');
  });
});
