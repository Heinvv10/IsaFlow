// Payroll pay components: the table becomes labelled cards below lg; the create form, its tick boxes and the RFI switch are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ components: [] as unknown[], patches: 0 }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/WriteOnly', () => ({ WriteOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (_url: string, init?: RequestInit) => { if (init?.method === 'PATCH') state.patches += 1; return new Response(JSON.stringify({ success: true, data: state.components }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }),
}));

import Page from '../../../pages/payroll/components/index';

const comp = { id: 'k1', name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true, paidOutsidePayroll: false, countsAsRfi: true };
afterEach(() => { cleanup(); state.components = [comp]; state.patches = 0; });
state.components = [comp];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Name', 'SARS', 'Type', 'Tax', 'UIF', 'SDL', 'RFI'];

describe('Payroll components on touch', () => {
  it('turns the table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Basic Salary');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    expect([...table.querySelectorAll('tbody tr:first-child td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('makes the create form fields, tick-box rows and Add component phone-sized', async () => {
    render(<Page />);
    await screen.findByText('Basic Salary');
    for (const id of ['new-component-name', 'new-component-code', 'new-component-type']) expect(cls(document.getElementById(id)!), id).toContain('max-lg:min-h-11');
    for (const name of ['Taxable', 'UIF applicable', 'SDL applicable', 'Counts as retirement-funding income']) expect(cls(screen.getByText(name).closest('label')!), name).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('button', { name: /Add component/ }))).toContain('max-lg:min-h-11');
  });

  it('keeps the Type text and the paid-outside-payroll note together in the card', async () => {
    state.components = [{ ...comp, id: 'k2', name: 'RA contribution', sarsSourceCode: '4006', componentType: 'deduction', paidOutsidePayroll: true }];
    render(<Page />);
    const note = await screen.findByText('paid outside payroll');
    const wrap = note.parentElement!;
    expect(cls(wrap)).toContain('max-lg:text-right');
    expect(cls(note)).toEqual(expect.arrayContaining(['max-lg:block', 'max-lg:ml-0']));
    expect(wrap.parentElement!.getAttribute('data-label')).toBe('Type');
  });

  it('a tap on the RFI switch tap area toggles once', async () => {
    render(<Page />);
    await screen.findByText('Basic Salary');
    const box = screen.getByRole('checkbox', { name: /Basic Salary counts as retirement-funding income/ });
    fireEvent.click(box.closest('label')!);
    await waitFor(() => expect(state.patches).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(state.patches).toBe(1);
  });

  it('gives the RFI switch a 44px tap area on phones', async () => {
    render(<Page />);
    await screen.findByText('Basic Salary');
    const box = screen.getByRole('checkbox', { name: /Basic Salary counts as retirement-funding income/ });
    const wrap = box.closest('label')!;
    expect(cls(wrap)).toEqual(expect.arrayContaining(['max-lg:inline-flex', 'max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:items-center', 'max-lg:justify-center']));
  });
});
