// Payroll batches list: the table becomes labelled cards below lg; links, buttons and the filter are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ batches: [] as unknown[], role: 'owner' }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/WriteOnly', () => ({ WriteOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: state.role }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.batches }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/payroll/batches/index';

const batch = { id: 'b1', batchType: 'component_values', description: 'Nov bonuses', periodYear: 2026, periodMonth: 11, status: 'draft', lineCount: 4, totalAmount: 12000, isRecurring: false, createdAt: '2026-11-01' };
afterEach(() => { cleanup(); state.batches = [batch]; state.role = 'owner'; });
state.batches = [batch];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Description', 'Type', 'Period', 'Status', 'Lines', 'Total', ''];

describe('Payroll batches list on touch', () => {
  it('turns the table into labelled cards; the trailing Open cell has no label', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Nov bonuses');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const row = table.querySelector(':scope > tbody > tr')!;
    expect([...row.querySelectorAll(':scope > td')].map((td) => td.getAttribute('data-label'))).toEqual([...HEADS.slice(0, 6), null]);
  });

  it('hides the empty trailing cell for a read-only role, keeps it for a writer', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Nov bonuses');
    expect(cls(container.querySelector('tbody tr')!.lastElementChild!)).not.toContain('max-lg:!hidden');
    cleanup(); state.role = 'viewer';
    const again = render(<Page />);
    await screen.findByText('Nov bonuses');
    expect(cls(again.container.querySelector('tbody tr')!.lastElementChild!)).toContain('max-lg:!hidden');
    expect(screen.queryByRole('link', { name: 'Open' })).toBeNull(); // the cell is hidden because it is empty
  });

  it('makes Open, New Batch and the status filter 44px; the header wraps', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Nov bonuses');
    const open = screen.getByRole('link', { name: 'Open' });
    for (const c of ['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11']) expect(cls(open), c).toContain(c);
    expect(cls(screen.getByRole('link', { name: /New Batch/ }))).toContain('max-lg:min-h-11');
    expect(cls(container.querySelector('select')!)).toContain('max-lg:min-h-11');
    const header = screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!;
    expect(cls(header)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('makes the empty-state Create first batch link 44px', async () => {
    state.batches = [];
    render(<Page />);
    expect(cls(await screen.findByRole('link', { name: /Create first batch/ }))).toContain('max-lg:min-h-11');
  });
});
