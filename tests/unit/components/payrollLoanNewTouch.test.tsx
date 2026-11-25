// New payroll loan: form controls are phone-sized, field groups stack, and the schedule preview becomes labelled cards below lg.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), back: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: [{ id: 'e1', employeeNumber: 'E001', firstName: 'Ann', lastName: 'Smith' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/payroll/loans/new';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');

describe('New payroll loan on touch', () => {
  it('makes every form control and both buttons phone-sized', async () => {
    const { container } = render(<Page />);
    await screen.findByText(/E001/);
    const controls = Array.from(container.querySelectorAll('form select, form input[type="number"], form input:not([type])'));
    expect(controls.length).toBeGreaterThanOrEqual(8);
    for (const c of controls) expect(cls(c), c.outerHTML.slice(0, 60)).toContain('max-lg:min-h-11');
    for (const name of ['Cancel', /Create/]) expect(cls(screen.getByRole('button', { name })), String(name)).toContain('max-lg:min-h-11');
  });

  it('stacks the multi-column field groups on phones', async () => {
    const { container } = render(<Page />);
    await screen.findByText(/E001/);
    const groups = Array.from(container.querySelectorAll('form .grid'));
    expect(groups).toHaveLength(3);
    for (const g of groups) expect(cls(g)).toContain('max-lg:grid-cols-1');
  });

  it('turns the schedule preview into labelled cards', async () => {
    const { container } = render(<Page />);
    await screen.findByText(/E001/);
    const [principal, , term] = Array.from(container.querySelectorAll('input[type="number"]'));
    fireEvent.change(principal, { target: { value: '12000' } });
    fireEvent.change(term, { target: { value: '12' } });
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    const row = table.querySelector('tbody tr')!;
    const labels = Array.from(row.querySelectorAll('td')).map((td) => td.getAttribute('data-label'));
    expect(labels).toEqual(['#', 'Period', 'Interest', 'Principal', 'Installment', 'Closing']);
    expect(Array.from(table.querySelectorAll('th')).map((th) => th.textContent)).toEqual(labels);
    expect(cls(table.parentElement!)).toContain('max-lg:max-h-none');
  });
});
