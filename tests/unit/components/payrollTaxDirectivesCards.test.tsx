// Payroll tax directives list: the table becomes labelled cards below lg; header, filters and row actions are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/payroll/tax-directives/index';

const dir = (id: string, status: string, type = 'lump_sum') => ({ id, employeeName: 'Ann Smith', employeeTaxNumber: '1234567890', directiveType: type, amount: 50000, taxRate: 0.18, taxAmount: 9000, effectiveDate: '2026-06-01', status });
afterEach(() => { cleanup(); state.rows = [dir('d1', 'pending')]; });
state.rows = [dir('d1', 'pending')];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Employee', 'Type', 'Effective', 'Amount (R)', 'Tax Rate %', 'Status', 'Actions'];

describe('Payroll tax directives on touch', () => {
  it('turns the table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Ann Smith');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    expect([...table.querySelectorAll('tbody tr:first-child > td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('makes the row actions 44px and lets them wrap', async () => {
    state.rows = [dir('d1', 'pending'), dir('d2', 'approved', 'fixed_percentage')];
    render(<Page />);
    await screen.findAllByText('Ann Smith');
    for (const b of [screen.getByRole('button', { name: 'Approve' }), ...screen.getAllByRole('button', { name: 'Cancel' })]) {
      expect(cls(b), b.textContent ?? '').toEqual(expect.arrayContaining(['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11']));
    }
    expect(cls(screen.getByRole('button', { name: 'Approve' }).parentElement!)).toContain('max-lg:flex-wrap');
  });

  it('keeps the employee name and tax number together, right-aligned, in the card', async () => {
    render(<Page />);
    const name = await screen.findByText('Ann Smith');
    const wrap = name.parentElement!;
    expect(cls(wrap)).toContain('max-lg:text-right');
    expect(screen.getByText('1234567890').closest('div.max-lg\\:text-right')).toBe(wrap);
    expect(wrap.parentElement!.getAttribute('data-label')).toBe('Employee');
  });

  it('makes Set expiry, Save and Close phone-sized and lets the expiry editor wrap', async () => {
    state.rows = [dir('d2', 'approved', 'fixed_percentage')];
    render(<Page />);
    const setExpiry = await screen.findByRole('button', { name: 'Set expiry' });
    expect(cls(setExpiry)).toEqual(expect.arrayContaining(['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11']));
    fireEvent.click(setExpiry);
    for (const name of ['Save', 'Close']) expect(cls(screen.getByRole('button', { name })), name).toEqual(expect.arrayContaining(['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11']));
    expect(cls(screen.getByRole('button', { name: 'Save' }).parentElement!)).toContain('max-lg:flex-wrap');
  });

  it('makes New Directive, the search box and the status filter phone-sized; the header and filter row wrap', async () => {
    render(<Page />);
    await screen.findByText('Ann Smith');
    expect(cls(screen.getByRole('button', { name: /New Directive/ }))).toContain('max-lg:min-h-11');
    const search = screen.getByPlaceholderText('Search by employee name...');
    expect(cls(search)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:w-full']));
    expect(cls(screen.getByRole('combobox'))).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
    expect(cls(search.closest('.mb-6')!)).toContain('max-lg:flex-wrap');
    expect(cls(search.parentElement!)).toContain('max-lg:w-full'); // the flex item is the wrapper, not the input
  });

  it('makes the empty-state New Directive button 44px', async () => {
    state.rows = [];
    render(<Page />);
    await screen.findByText('No tax directives');
    const btns = screen.getAllByRole('button', { name: /New Directive/ });
    expect(btns).toHaveLength(2);
    for (const b of btns) expect(cls(b)).toContain('max-lg:min-h-11');
  });
});
