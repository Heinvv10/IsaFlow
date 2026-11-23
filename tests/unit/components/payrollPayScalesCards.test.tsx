// Payroll pay scales: the scale table becomes labelled cards below lg; the create form and status toggle are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ scales: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/WriteOnly', () => ({ WriteOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.scales }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/payroll/pay-scales/index';

const scale = { id: 's1', code: 'G5', name: 'Senior clerk', gradeLevel: 5, minSalary: 20000, midSalary: 25000, maxSalary: 30000, isActive: true };
afterEach(() => { cleanup(); state.scales = [scale]; });
state.scales = [scale];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Code', 'Name', 'Grade', 'Min', 'Mid', 'Max', 'Status'];

describe('Payroll pay scales on touch', () => {
  it('turns the table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Senior clerk');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    expect([...table.querySelectorAll('tbody tr:first-child td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('centres the Status toggle against its label, and lets Code span the row below md', async () => {
    render(<Page />);
    await screen.findByText('Senior clerk');
    expect(cls(screen.getByRole('button', { name: 'Active' }).closest('td')!)).toContain('max-lg:items-center');
    expect(cls(screen.getByPlaceholderText('Code (G5)'))).toEqual(expect.arrayContaining(['col-span-2', 'md:col-span-1']));
  });

  it('centres the empty-state cell and keeps it roomy in card mode', async () => {
    state.scales = [];
    render(<Page />);
    const cell = (await screen.findByText('No pay scales yet.')).closest('td')!;
    expect(cls(cell)).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
    expect(cell.hasAttribute('data-label')).toBe(false);
  });

  it('makes the Active toggle, every form field and Create phone-sized', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Senior clerk');
    expect(cls(screen.getByRole('button', { name: 'Active' }))).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:px-4']));
    const fields = container.querySelectorAll('section input');
    expect(fields).toHaveLength(6);
    for (const f of fields) expect(cls(f), f.getAttribute('placeholder') ?? '').toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('button', { name: /Create/ }))).toContain('max-lg:min-h-11');
  });
});
