// Payroll training events: the table becomes labelled cards below lg; the header, capture form and status pill are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/WriteOnly', () => ({ WriteOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify({ success: true, data: String(url).includes('/employees') ? [{ id: 'e1', employeeNumber: 'E001', firstName: 'Ann', lastName: 'Smith' }] : state.events }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/payroll/training/index';

const ev = { id: 't1', employeeId: 'e1', category: 'short_course', description: 'First aid level 2', provider: 'Red Cross', nqfLevel: 3, plannedStart: '2026-03-01', plannedEnd: '2026-03-05', actualStart: null, actualEnd: null, costPlanned: 4500, costActual: 0, status: 'planned' };
afterEach(() => { cleanup(); state.events = [ev]; });
state.events = [ev];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Employee', 'Category', 'Description', 'Provider', 'NQF', 'Planned', 'Cost', 'Status'];

describe('Payroll training on touch', () => {
  it('turns the table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('First aid level 2');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    expect([...table.querySelectorAll('tbody tr:first-child td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('centres the empty-state cell in card mode', async () => {
    state.events = [];
    render(<Page />);
    const cell = (await screen.findByText(/No training events recorded/)).closest('td')!;
    expect(cls(cell)).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
    expect(cell.hasAttribute('data-label')).toBe(false);
  });

  it('makes the status pill 44px', async () => {
    render(<Page />);
    await screen.findByText('First aid level 2');
    const pill = screen.getAllByRole('combobox').find((s) => (s as HTMLSelectElement).value === 'planned')!;
    expect(cls(pill)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:px-3']));
  });

  it('makes the header controls phone-sized and lets the header wrap', async () => {
    render(<Page />);
    await screen.findByText('First aid level 2');
    expect(cls(screen.getByRole('button', { name: /New event/ }))).toContain('max-lg:min-h-11');
    const year = screen.getByDisplayValue(String(new Date().getFullYear()));
    expect(cls(year)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('makes every capture-form field, the close X and Save 44px', async () => {
    const { container } = render(<Page />);
    await screen.findByText('First aid level 2');
    fireEvent.click(screen.getByRole('button', { name: /New event/ }));
    const form = container.querySelector('section')!;
    const fields = form.querySelectorAll('select, input[type="text"], input[type="number"]');
    expect(fields.length).toBe(8); // six own fields and the two shared date inputs
    for (const f of fields) expect(cls(f), f.getAttribute('placeholder') ?? f.tagName).toContain('max-lg:min-h-11');
    // a bare col-span-2 inside the one-column phone grid adds a second implicit column and squashes every field
    const desc = screen.getByPlaceholderText('Description');
    expect(cls(desc)).toContain('md:col-span-2');
    expect(cls(desc)).not.toContain('col-span-2');
    expect(cls(screen.getByRole('button', { name: 'Save' }))).toContain('max-lg:min-h-11');
    const close = form.querySelector('h2 + button')!;
    expect(cls(close)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']));
  });
});
