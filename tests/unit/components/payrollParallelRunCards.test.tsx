// Payroll parallel run: the imports table becomes labelled cards below lg; its row icon buttons and the upload card controls are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ imports: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/payroll/WriteOnly', () => ({ WriteOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/payroll/parallelRun/ParallelRunReportView', () => ({ ParallelRunReportView: () => null }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { imports: state.imports } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/payroll/parallel-run/index';

const imp = { id: 'i1', periodMonth: 3, periodYear: 2026, source: 'VIP Premier', fileName: 'march-payslips.csv', payslipCount: 42, createdAt: '2026-04-01' };
afterEach(() => { cleanup(); state.imports = [imp]; });
state.imports = [imp];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Period', 'Source', 'File', 'Payslips', 'Actions'];
const SQUARE = ['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center'];

describe('Payroll parallel run on touch', () => {
  it('turns the imports table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Mar 2026');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    expect([...table.querySelectorAll('tbody tr:first-child td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('centres the empty-state cell in card mode', async () => {
    state.imports = [];
    render(<Page />);
    const cell = (await screen.findByText(/No imports yet/)).closest('td')!;
    expect(cls(cell)).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
    expect(cell.hasAttribute('data-label')).toBe(false);
  });

  it('makes the export and delete icon buttons 44px squares', async () => {
    render(<Page />);
    await screen.findByText('Mar 2026');
    for (const title of ['Export comparison CSV', 'Delete import']) expect(cls(screen.getByTitle(title)), title).toEqual(expect.arrayContaining(SQUARE));
  });

  it('makes the upload card phone-sized: both period selects, the source box and Choose CSV', async () => {
    render(<Page />);
    await screen.findByText('Mar 2026');
    const boxes = screen.getAllByRole('combobox');
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(cls(b)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByPlaceholderText('e.g. VIP Premier'))).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('button', { name: /Choose CSV/ }))).toContain('max-lg:min-h-11');
  });
});
