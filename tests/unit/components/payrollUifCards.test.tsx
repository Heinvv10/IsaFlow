// Payroll UIF declarations: the table becomes labelled cards below lg; header, year filter, Mark Submitted and the generate dialog are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/WriteOnly', () => ({ WriteOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/payroll/uif/index';

const row = (id: string, status: string) => ({ id, periodYear: new Date().getFullYear(), periodMonth: 3, totalEmployees: 12, totalLeviableSalary: 150000, totalEmployeeContribution: 1500, totalEmployerContribution: 1500, totalUif: 3000, status, submittedAt: status === 'draft' ? null : '2026-04-02' });
afterEach(() => { cleanup(); state.rows = [row('u1', 'draft'), row('u2', 'submitted')]; });
state.rows = [row('u1', 'draft'), row('u2', 'submitted')];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Period', 'Employees', 'Leviable Salary', 'Employee 1%', 'Employer 1%', 'Total UIF', 'Status', 'Action'];

describe('Payroll UIF declarations on touch', () => {
  it('turns the table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Mark Submitted');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    for (const tr of table.querySelectorAll('tbody tr')) expect([...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('makes Mark Submitted, Generate Declaration and the year filter phone-sized; the header wraps', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Mark Submitted');
    expect(cls(screen.getByRole('button', { name: /Mark Submitted/ }))).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('button', { name: /Generate Declaration/ }))).toContain('max-lg:min-h-11');
    expect(cls(container.querySelector('select')!)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('makes the empty-state Generate Declaration button 44px', async () => {
    state.rows = [];
    render(<Page />);
    await screen.findByText('No UIF declarations');
    const btns = screen.getAllByRole('button', { name: /Generate Declaration/ });
    expect(btns).toHaveLength(2);
    for (const b of btns) expect(cls(b)).toContain('max-lg:min-h-11');
  });

  it('makes the generate dialog phone-sized: padded overlay, 44px selects, Cancel and Generate', async () => {
    render(<Page />);
    await screen.findByText('Mark Submitted');
    fireEvent.click(screen.getByRole('button', { name: /Generate Declaration/ }));
    const dialogTitle = screen.getByText('Generate UIF Declaration');
    const overlay = dialogTitle.parentElement!.parentElement!;
    // a short landscape phone scrolls the dialog instead of clipping it; start-aligned + my-auto keeps it centred when it fits and its top reachable when it does not
    expect(cls(overlay)).toEqual(expect.arrayContaining(['max-lg:p-4', 'max-lg:overflow-y-auto', 'max-lg:items-start']));
    expect(cls(dialogTitle.parentElement!)).toContain('max-lg:my-auto');
    const selects = dialogTitle.parentElement!.querySelectorAll('select');
    expect(selects).toHaveLength(2);
    for (const s of selects) expect(cls(s)).toContain('max-lg:min-h-11');
    for (const name of ['Cancel', 'Generate']) expect(cls(screen.getByRole('button', { name })), name).toContain('max-lg:min-h-11');
  });
});
