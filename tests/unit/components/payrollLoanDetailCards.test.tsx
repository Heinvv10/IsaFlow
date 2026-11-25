// Payroll loan detail: schedule and payments tables become labelled cards below lg; header actions and stats fit a phone.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'l1' }, push: vi.fn(), back: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
const state = vi.hoisted(() => ({ status: 'active' }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: {
    loan: { id: 'l1', loanNumber: 'EL-001', description: 'Laptop advance', employeeId: 'e1', principal: 12000, annualInterestRate: 0.105, termMonths: 12, method: 'declining_balance', status: state.status, outstandingBalance: 9000, totalInterestCharged: 100, totalPrincipalPaid: 3000, startDate: '2026-01-01', firstPeriodYear: 2026, firstPeriodMonth: 1 },
    schedule: [
      { id: 's1', sequence: 1, duePeriodYear: 2026, duePeriodMonth: 1, openingBalance: 12000, interest: 105, principal: 900, installment: 1005, closingBalance: 11100, paidFlag: true },
      { id: 's2', sequence: 2, duePeriodYear: 2026, duePeriodMonth: 2, openingBalance: 11100, interest: 97, principal: 908, installment: 1005, closingBalance: 10192, paidFlag: false },
    ],
    payments: [{ id: 'p1', periodYear: 2026, periodMonth: 1, openingBalance: 12000, interestCharged: 105, principalPaid: 900, fringeBenefit: 0, closingBalance: 11100 }],
  } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/payroll/loans/[id]';

afterEach(() => { cleanup(); state.status = 'active'; });
const cls = (el: Element) => el.className.split(' ');
const heads = (t: Element) => Array.from(t.querySelectorAll('th')).map((th) => th.textContent ?? '');
const labels = (row: Element) => Array.from(row.querySelectorAll('td')).map((td) => td.getAttribute('data-label'));

describe('Payroll loan detail on touch', () => {
  it('turns the schedule into labelled cards; the paid tick shows only on paid rows', async () => {
    const { container } = render(<Page />);
    await screen.findByText(/EL-001/);
    const table = container.querySelectorAll('table')[0];
    expect(cls(table)).toContain('table-cards');
    const rows = table.querySelectorAll('tbody tr');
    expect(labels(rows[0])).toEqual(['#', 'Period', 'Opening', 'Interest', 'Principal', 'Installment', 'Closing', 'Paid']);
    expect(heads(table)).toEqual(['#', 'Period', 'Opening', 'Interest', 'Principal', 'Installment', 'Closing', '']);
    expect(cls(table.parentElement!)).toContain('max-lg:max-h-none');
    const paid = (r: Element) => r.querySelectorAll('td')[7];
    expect(cls(paid(rows[0]))).not.toContain('max-lg:!hidden');
    expect(cls(paid(rows[1]))).toContain('max-lg:!hidden');
  });

  it('turns the payments table into labelled cards', async () => {
    const { container } = render(<Page />);
    await screen.findByText(/EL-001/);
    const table = container.querySelectorAll('table')[1];
    expect(cls(table)).toContain('table-cards');
    expect(labels(table.querySelector('tbody tr')!)).toEqual(heads(table));
  });

  it('makes Back, Settle and Write off phone-sized and lets the header and stats reflow', async () => {
    const { container } = render(<Page />);
    await screen.findByText(/EL-001/);
    const back = container.querySelector('a[href="/payroll/loans"]')!;
    expect(cls(back)).toContain('max-lg:min-h-11');
    expect(cls(back)).toContain('max-lg:min-w-11');
    const settle = screen.getByRole('button', { name: /Settle/ });
    for (const b of [settle, screen.getByRole('button', { name: /Write off/ })]) expect(cls(b)).toContain('max-lg:min-h-11');
    expect(cls(settle.parentElement!)).toContain('max-lg:flex-wrap');
    const header = settle.parentElement!.parentElement!;
    expect(cls(header)).toContain('max-lg:flex-wrap');
    expect(cls(header)).toContain('max-lg:gap-3');
    expect(cls(screen.getByText('Principal', { selector: 'div' }).parentElement!.parentElement!)).toContain('max-lg:grid-cols-2');
  });

  it('shows no close actions on a settled loan', async () => {
    state.status = 'settled';
    render(<Page />);
    await screen.findByText(/EL-001/);
    expect(screen.queryByRole('button', { name: /Settle/ })).toBeNull();
  });
});
