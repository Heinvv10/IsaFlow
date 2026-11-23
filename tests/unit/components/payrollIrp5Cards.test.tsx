// Payroll IRP5 readiness: the employee table becomes labelled cards below lg; the header controls are phone-sized and wrap.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
const summary = {
  taxYear: 2026, totalEmployees: 2, certificatesReady: 1, incomplete: 1, missing: 0, totalPayeSubmitted: 12000, componentIssues: [],
  employees: [
    { employeeId: 'e1', firstName: 'Ann', lastName: 'Smith', idNumber: '8001015009087', taxNumber: '1234567890', startDate: '2025-03-01', endDate: null, totalGross: 300000, totalPaye: 8000, totalUif: 177, totalSdl: 3000, status: 'ready', messages: [] },
    { employeeId: 'e2', firstName: 'Bob', lastName: 'Jones', idNumber: null, taxNumber: null, startDate: '2025-03-01', endDate: null, totalGross: 200000, totalPaye: 4000, totalUif: 177, totalSdl: 2000, status: 'incomplete', messages: [] },
  ],
};
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: summary }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/payroll/irp5/index';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Employee', 'ID / Passport', 'Tax Number', 'Gross', 'PAYE', 'UIF', 'SDL', 'Status'];

describe('Payroll IRP5 readiness on touch', () => {
  it('turns the employee table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Ann Smith');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    expect([...table.querySelectorAll('tbody tr:first-child td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('makes the tax-year select and both export buttons 44px; the header and its control group wrap', async () => {
    render(<Page />);
    await screen.findByText('Ann Smith');
    const select = screen.getByLabelText('Tax year');
    expect(cls(select)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:w-full']));
    for (const name of [/Export CSV/, /e@syFile IRP5/]) expect(cls(screen.getByRole('button', { name })), String(name)).toContain('max-lg:min-h-11');
    expect(cls(select.parentElement!)).toContain('max-lg:flex-wrap');
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });
});
