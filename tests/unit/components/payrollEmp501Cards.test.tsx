// Payroll EMP501 reconciliation: the monthly table (and its totals row) becomes labelled cards below lg; header controls and the blocked-annual button are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ blockAnnual: false }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/emp501/Emp501ReturnSection', () => ({ Emp501ReturnSection: () => null }));
const summary = {
  taxYear: 2027, totalEmp201: 12000, totalIrp5: 11000, totalVariance: 1000, runWarnings: [],
  rows: [
    { month: 3, monthLabel: 'March 2026', year: 2026, emp201Paye: 6000, irp5Paye: 6000, variance: 0, status: 'balanced' },
    { month: 4, monthLabel: 'April 2026', year: 2026, emp201Paye: 6000, irp5Paye: 5000, variance: 1000, status: 'variance' },
    { month: 5, monthLabel: 'May 2026', year: 2026, emp201Paye: 0, irp5Paye: 0, variance: 0, status: 'no_data' },
  ],
};
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => {
    if (state.blockAnnual && String(url).includes('period=annual')) {
      return new Response(JSON.stringify({ success: false, error: { details: { code: 'RUN_KIND_UNSUPPORTED', reasons: [{ detail: 'run R9 is weekly' }] } } }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, data: summary }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

import Page from '../../../pages/payroll/emp501/index';

afterEach(() => { cleanup(); state.blockAnnual = false; });
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Period', 'EMP201 PAYE', 'IRP5 PAYE', 'Variance', 'Status'];

describe('Payroll EMP501 on touch', () => {
  it('turns the table into labelled cards; the totals row keeps its labels, with Total as the unlabelled heading', async () => {
    const { container } = render(<Page />);
    await screen.findByText('March 2026');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(4); // three months and the totals row
    for (const tr of rows.slice(0, 3)) expect([...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
    expect([...rows[3].querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, ...HEADS.slice(1)]);
  });

  it('makes the tax-year select and the export button 44px', async () => {
    render(<Page />);
    await screen.findByText('March 2026');
    expect(cls(screen.getByLabelText('Tax year'))).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('button', { name: /Export e@syFile CSV/ }))).toContain('max-lg:min-h-11');
  });

  it('makes Show the interim 44px when the annual is blocked', async () => {
    render(<Page />);
    await screen.findByText('March 2026');
    state.blockAnnual = true;
    const select = screen.getByLabelText('Tax year') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: String(Number(select.options[0].value)) } }); // the earliest offered year defaults to the annual return
    const btn = await screen.findByRole('button', { name: 'Show the interim' });
    expect(cls(btn)).toContain('max-lg:min-h-11');
  });
});
