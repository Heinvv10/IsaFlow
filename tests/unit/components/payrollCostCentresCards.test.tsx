// Payroll cost centres: the table becomes labelled cards below lg; the add form, row actions, edit controls and GL mapping select are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/WriteOnly', () => ({ WriteOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
const data = {
  cc: [{ id: 'c1', code: 'ADMIN', name: 'Administration', parentId: null, isActive: true, notes: null }],
  map: [{ costCentreId: 'c1', expenseAccountId: 'a1', accountCode: '6000', accountName: 'Salaries' }],
  acct: [{ id: 'a1', accountCode: '6000', accountName: 'Salaries', accountType: 'expense' }],
};
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.includes('gl-mappings') ? data.map : u.includes('chart-of-accounts') ? data.acct : data.cc;
    return new Response(JSON.stringify({ success: true, data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

import Page from '../../../pages/payroll/cost-centres/index';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Code', 'Name', 'GL expense account', 'Status', ''];
const LINK = ['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11'];

describe('Payroll cost centres on touch', () => {
  it('turns the table into labelled cards; the actions cell has no label and hides when empty', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Administration');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const tds = [...table.querySelectorAll('tbody tr:first-child > td')];
    expect(tds.map((td) => td.getAttribute('data-label'))).toEqual(['Code', 'Name', 'GL expense account', 'Status', null]);
    expect(cls(tds[4])).toContain('max-lg:empty:!hidden'); // a viewer's actions cell renders nothing: no empty card block
  });

  it('makes Edit, Deactivate and the GL mapping select phone-sized', async () => {
    render(<Page />);
    await screen.findByText('Administration');
    for (const name of ['Edit', 'Deactivate']) expect(cls(screen.getByRole('button', { name })), name).toEqual(expect.arrayContaining(LINK));
    const select = screen.getByRole('combobox');
    expect(cls(select)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:flex-1', 'max-lg:min-w-[10rem]']));
    // the label and the control share a flex row in card mode: let the control drop to its own line when it does not fit
    expect(cls(select.closest('td')!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-2']));
  });

  it('makes the edit inputs and the save/cancel icon buttons phone-sized', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Administration');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const row = container.querySelector('tbody tr')!;
    const inputs = row.querySelectorAll('input');
    expect(inputs).toHaveLength(2);
    for (const i of inputs) {
      expect(cls(i)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:flex-1', 'max-lg:min-w-[10rem]', 'max-lg:w-auto']));
      expect(cls(i.closest('td')!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-2']));
    }
    const icons = row.querySelectorAll('td:last-child button');
    expect(icons).toHaveLength(2);
    for (const b of icons) expect(cls(b)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']));
  });

  it('stacks the add form on phones (no inline grid-template) with 44px fields and Add; the header wraps and Show inactive is 44px', async () => {
    render(<Page />);
    await screen.findByText('Administration');
    const code = screen.getByPlaceholderText('Code (e.g. ADMIN)');
    const form = code.parentElement!;
    expect(cls(form)).toEqual(expect.arrayContaining(['max-lg:grid-cols-1', 'grid-cols-[1fr_2fr_auto]']));
    expect(form.getAttribute('style')).toBeNull();
    for (const el of [code, screen.getByPlaceholderText('Name'), screen.getByRole('button', { name: /Add/ })]) expect(cls(el)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByText('Show inactive').closest('label')!)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });
});
