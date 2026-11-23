// Payroll employee loans list: the table becomes labelled cards below lg; links, buttons and the filter are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ loans: [] as unknown[], components: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/WriteOnly', () => ({ WriteOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => {
    const data = String(url).includes('/components') ? state.components : state.loans;
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

import Page from '../../../pages/payroll/loans/index';

const loan = { id: 'l1', employeeId: 'e1', loanNumber: 'EL-001', description: 'Laptop advance', principal: 12000, outstandingBalance: 9000, annualInterestRate: 0.105, termMonths: 12, method: 'declining_balance', status: 'active', startDate: '2026-01-01' };
const bothComponents = [{ sarsSourceCode: 'LOAN' }, { sarsSourceCode: '3801' }];
afterEach(() => { cleanup(); state.loans = [loan]; state.components = bothComponents; });
state.loans = [loan]; state.components = bothComponents;
const min = (el: Element, name: string) => expect(el.className.split(' '), name).toContain('max-lg:min-h-11');
const HEADS = ['Loan #', 'Description', 'Method', 'Status', 'Rate', 'Principal', 'Outstanding', ''];

describe('Payroll loans list on touch', () => {
  it('turns the loans table into labelled cards; the trailing Open cell has no label', async () => {
    const { container } = render(<Page />);
    await screen.findByText('EL-001');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const row = table.querySelector(':scope > tbody > tr')!;
    expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual([...HEADS.slice(0, 7), null]);
  });

  it('makes Open, New Loan and the status filter 44px; the header wraps', async () => {
    const { container } = render(<Page />);
    await screen.findByText('EL-001');
    const open = screen.getByRole('link', { name: 'Open' });
    for (const c of ['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11']) expect(open.className, c).toContain(c);
    min(screen.getByRole('link', { name: /New Loan/ }), 'New Loan');
    min(container.querySelector('select')!, 'status filter');
    expect(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('makes the create-components banner wrap and its button 44px when components are missing', async () => {
    state.components = [];
    render(<Page />);
    const btn = await screen.findByRole('button', { name: 'Create loan components' });
    min(btn, 'create components');
    expect(btn.parentElement!.className.split(' ')).toContain('max-lg:flex-wrap'); // WriteOnly renders no wrapper, so the banner is the parent
  });

  it('makes the empty-state Create first loan link 44px', async () => {
    state.loans = [];
    render(<Page />);
    min(await screen.findByRole('link', { name: /Create first loan/ }), 'create first');
  });
});
