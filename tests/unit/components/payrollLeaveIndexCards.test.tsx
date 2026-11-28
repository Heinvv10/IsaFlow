// Payroll leave list: the table becomes labelled cards below lg; links, filters and the header are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/WriteOnly', () => ({ WriteOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/payroll/leave/index';

const row = { id: 'r1', employeeName: 'Ann Smith', employeeNumber: 'E001', leaveTypeName: 'Annual leave', startDate: '2026-11-02', endDate: '2026-11-06', days: 5, status: 'pending', createdAt: '2026-10-30' };
afterEach(() => { cleanup(); state.rows = [row]; });
state.rows = [row];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Employee', 'Leave Type', 'From', 'To', 'Days', 'Status', ''];

describe('Payroll leave list on touch', () => {
  it('turns the table into labelled cards; the trailing View cell has no label', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Ann Smith');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const row0 = table.querySelector(':scope > tbody > tr')!;
    expect([...row0.querySelectorAll(':scope > td')].map((td) => td.getAttribute('data-label'))).toEqual([...HEADS.slice(0, 6), null]);
  });

  it('makes View, Balances and New Request 44px; the header and filter row wrap', async () => {
    render(<Page />);
    await screen.findByText('Ann Smith');
    const view = screen.getByRole('link', { name: 'View' });
    for (const c of ['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11']) expect(cls(view), c).toContain(c);
    expect(cls(screen.getByRole('link', { name: 'Balances' }))).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('link', { name: /New Request/ }))).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
    expect(cls(screen.getAllByRole('combobox')[0].closest('.mb-6')!)).toContain('max-lg:flex-wrap');
  });

  it('keeps the employee name and number together, right-aligned, instead of three flex items', async () => {
    render(<Page />);
    const name = await screen.findByText('Ann Smith');
    const wrap = name.parentElement!;
    expect(cls(wrap)).toContain('max-lg:text-right');
    const number = screen.getByText('E001');
    expect(number.parentElement).toBe(wrap);
    expect(cls(number)).toEqual(expect.arrayContaining(['max-lg:block', 'max-lg:ml-0']));
    expect(wrap.parentElement!.getAttribute('data-label')).toBe('Employee');
  });

  it('gives both filters a phone-sized trigger', async () => {
    render(<Page />);
    await screen.findByText('Ann Smith');
    const boxes = screen.getAllByRole('combobox');
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(cls(b)).toContain('max-lg:min-h-11');
  });

  it('makes the empty-state New Request link 44px', async () => {
    state.rows = [];
    render(<Page />);
    const links = await screen.findAllByRole('link', { name: /New Request/ });
    for (const l of links) expect(cls(l)).toContain('max-lg:min-h-11');
  });
});
