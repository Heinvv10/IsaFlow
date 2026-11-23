// Payroll leave balances: the employee x leave-type pivot becomes one card per employee (a labelled row per leave type); header controls are phone-sized and wrap.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/WriteOnly', () => ({ WriteOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
const row = (employeeId: string, employeeName: string, leaveTypeName: string, accrued: number, balance: number) => ({ employeeId, employeeName, leaveTypeId: leaveTypeName, leaveTypeName, accrued, taken: accrued - balance, pending: 0, balance });
// Ann has Annual and Sick; Bob has only Annual (so his Sick cell is the dash placeholder)
const rows = [row('e1', 'Ann Smith', 'Annual', 15, 12), row('e1', 'Ann Smith', 'Sick', 10, 2), row('e2', 'Bob Jones', 'Annual', 15, 3)];
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/payroll/leave/balances';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');

describe('Payroll leave balances on touch', () => {
  it('turns the pivot into one card per employee: the name is the heading, each leave type a labelled row (incl. the dash)', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Ann Smith');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(heads).toEqual(['Employee', 'Annual', 'Sick']);
    const rowsEls = [...table.querySelectorAll('tbody tr')];
    expect(rowsEls).toHaveLength(2);
    for (const tr of rowsEls) expect([...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, 'Annual', 'Sick']);
    expect(rowsEls[1].querySelectorAll('td')[2].textContent).toBe('—'); // Bob has no Sick balance
  });

  it('keeps a balance and its accrual together (one flex item beside the label), not spread across the card', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Ann Smith');
    const cell = container.querySelector('td[data-label="Annual"]')!;
    expect(cell.children).toHaveLength(1);
    expect(cell.children[0].textContent).toBe('12.0/ 15.0');
    expect(cls(cell.children[0])).toContain('max-lg:text-right');
  });

  it('makes Back, both actions and the year select 44px; the header and its control group wrap', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Ann Smith');
    expect(cls(container.querySelector('a[href="/payroll/leave"]')!)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']));
    for (const name of [/Run Monthly Accrual/, /Roll Over Year/]) expect(cls(screen.getByRole('button', { name })), String(name)).toContain('max-lg:min-h-11');
    const select = container.querySelector('select')!;
    expect(cls(select)).toContain('max-lg:min-h-11');
    expect(cls(select.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:ml-0']));
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });
});
