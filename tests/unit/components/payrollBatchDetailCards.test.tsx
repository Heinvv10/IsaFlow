// Payroll batch detail: the lines table becomes labelled cards below lg (both batch types); header, row remove, add-rows form and Add to batch are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ type: 'reimbursive_travel' as string, status: 'draft' as string, lines: [] as unknown[] }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'b1' }, push: vi.fn(), back: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => {
    const data = String(url).includes('/employees')
      ? [{ id: 'e1', employeeNumber: 'E001', firstName: 'Ann', lastName: 'Smith' }]
      : { batch: { id: 'b1', batchType: state.type, componentId: null, description: 'November travel', periodYear: 2026, periodMonth: 11, isRecurring: false, status: state.status, lineCount: state.lines.length, totalAmount: 900 }, lines: state.lines };
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

import Page from '../../../pages/payroll/batches/[id]';

const line = (id: string, error: string | null = null) => ({ id, employeeId: 'e1', employeeNumber: 'E001', employeeName: 'Ann Smith', value: 900, km: 200, ratePerKm: 4.5, taxablePortion: 0, nonTaxablePortion: 900, effectiveFrom: '2026-11-01', effectiveTo: null, error, notes: null });
afterEach(() => { cleanup(); state.type = 'reimbursive_travel'; state.status = 'draft'; state.lines = [line('l1'), line('l2', 'Rate above the SARS limit')]; });
state.lines = [line('l1'), line('l2', 'Rate above the SARS limit')];
const cls = (el: Element) => el.className.split(' ');
const SQUARE = ['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center'];
const TRAVEL = ['Employee', 'km', 'Rate/km', '3703 (non-tax)', '3702 (tax)', 'Error', ''];

describe('Payroll batch detail on touch', () => {
  it('travel batch: labelled cards matching the headers; Error and the remove cell hide when empty', async () => {
    const { container } = render(<Page />);
    await screen.findByText(/November travel/);
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(TRAVEL);
    const rows = [...table.querySelectorAll('tbody tr')];
    for (const tr of rows) expect([...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([...TRAVEL.slice(0, 6), null]);
    const errCell = (tr: Element) => tr.querySelector('td[data-label="Error"]')!;
    expect(cls(errCell(rows[0]))).toContain('max-lg:!hidden'); // no error on this line
    expect(cls(errCell(rows[1]))).not.toContain('max-lg:!hidden');
  });

  it('component batch: Amount replaces the four travel columns in the labels', async () => {
    state.type = 'component_values';
    const { container } = render(<Page />);
    await screen.findByText(/November travel/);
    const row = container.querySelector('tbody tr')!;
    expect([...row.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(['Employee', 'Amount', 'Error', null]);
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Employee', 'Amount', 'Error', '']);
  });

  it('a posted batch has no remove buttons, so the actions cell hides', async () => {
    state.status = 'posted';
    const { container } = render(<Page />);
    await screen.findByText(/November travel/);
    const cell = container.querySelector('tbody tr:first-child > td:last-child')!;
    expect(cls(cell)).toContain('max-lg:!hidden');
    expect(cell.childNodes).toHaveLength(0);
  });

  it('centres the empty-state cell', async () => {
    state.lines = [];
    render(<Page />);
    const cell = (await screen.findByText(/No lines yet/)).closest('td')!;
    expect(cls(cell)).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
  });

  it('makes the header controls and the row remove buttons phone-sized; the header wraps', async () => {
    const { container } = render(<Page />);
    await screen.findByText(/November travel/);
    expect(cls(container.querySelector('a[href="/payroll/batches"]')!)).toEqual(expect.arrayContaining(SQUARE));
    expect(cls(screen.getByRole('button', { name: /Validate/ }))).toContain('max-lg:min-h-11');
    for (const b of container.querySelectorAll('tbody td:last-child button')) expect(cls(b)).toEqual(expect.arrayContaining(SQUARE));
    const header = screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!;
    expect(cls(header)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('makes the post button 44px on a validated batch', async () => {
    state.status = 'validated';
    render(<Page />);
    await screen.findByText(/November travel/);
    expect(cls(screen.getByRole('button', { name: /^Post$/ }))).toContain('max-lg:min-h-11');
  });

  it('add-rows: the draft grid stacks on phones with 44px fields, remove-draft and Add to batch; Another row is 44px', async () => {
    const { container } = render(<Page />);
    await screen.findByText(/November travel/);
    const another = screen.getByRole('button', { name: /Another row/ });
    expect(cls(another)).toContain('max-lg:min-h-11'); // already inline-flex items-center
    fireEvent.click(another);
    const draft = screen.getAllByRole('combobox')[0].parentElement!;
    expect(cls(draft)).toEqual(expect.arrayContaining(['max-lg:grid-cols-1', 'grid-cols-[2fr_1fr_1fr_auto]']));
    expect(draft.getAttribute('style')).toBeNull();
    for (const f of container.querySelectorAll('[class*="grid-cols-["] select, [class*="grid-cols-["] input')) expect(cls(f), f.getAttribute('placeholder') ?? 'select').toContain('max-lg:min-h-11');
    for (const b of container.querySelectorAll('[class*="grid-cols-["] button')) expect(cls(b)).toEqual(expect.arrayContaining(SQUARE));
    expect(cls(screen.getByRole('button', { name: /Add to batch/ }))).toContain('max-lg:min-h-11');
  });

  it('component batch draft grid uses the three-column template', async () => {
    state.type = 'component_values';
    render(<Page />);
    await screen.findByText(/November travel/);
    expect(cls(screen.getAllByRole('combobox')[0].parentElement!)).toEqual(expect.arrayContaining(['max-lg:grid-cols-1', 'grid-cols-[2fr_1fr_auto]']));
    expect(cls(screen.getByPlaceholderText('Amount'))).toContain('max-lg:min-h-11');
  });
});
