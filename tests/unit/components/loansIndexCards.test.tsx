// Loan portfolio: the loans table becomes labelled cards below lg; links, filters and the header are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ loans: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => {
    const data = String(url).includes('portfolio/summary')
      ? { totalOutstanding: 1000, weightedAvgRate: 10, next12mInterest: 100, totalCurrentPortion: 50, activeCount: 1, maturity: [] }
      : state.loans;
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

import Page from '../../../pages/accounting/loans/index';

afterEach(cleanup);
const loan = { id: 'l1', reference: 'LN-001', product: 'term_loan', principal: 50000, rateMode: 'FIXED', fixedRate: 11.5, margin: 0, startDate: '2026-01-01', status: 'active' };
const min = (el: Element, name: string) => expect(el.className, name).toContain('max-lg:min-h-11');
const HEADS = ['Reference', 'Product', 'Principal', 'Rate', 'Start', 'Status', ''];

describe('Loan portfolio on touch', () => {
  it('turns the loans table into labelled cards; the trailing action cell has no label', async () => {
    state.loans = [loan];
    const { container } = render(<Page />);
    await screen.findByText('LN-001');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const row = table.querySelector(':scope > tbody > tr')!;
    expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual([...HEADS.slice(0, 6), null]);
  });

  it('makes the reference and View links 44px, centred against their labels', async () => {
    state.loans = [loan];
    render(<Page />);
    await screen.findByText('LN-001');
    for (const name of ['LN-001', /View/]) {
      const link = screen.getByRole('link', { name });
      for (const c of ['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11']) expect(link.className, String(name)).toContain(c);
    }
    expect(screen.getByRole('link', { name: 'LN-001' }).closest('td')!.className).toContain('max-lg:items-center');
  });

  it('makes New Loan, the search and both filters 44px; the search takes the full row', async () => {
    state.loans = [loan];
    const { container } = render(<Page />);
    await screen.findByText('LN-001');
    min(screen.getByRole('link', { name: /New Loan/ }), 'New Loan');
    expect(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
    const search = screen.getByPlaceholderText(/Search reference/);
    for (const c of ['max-lg:min-h-11', 'max-lg:w-full']) expect(search.className.split(' '), c).toContain(c);
    expect(search.parentElement!.className.split(' ')).toContain('max-lg:w-full');
    const selects = container.querySelectorAll('select');
    expect(selects).toHaveLength(2);
    for (const s of selects) min(s, 'filter');
  });

  it('keeps the empty-state message centred and its link 44px on a card', async () => {
    state.loans = [];
    render(<Page />);
    // First paint, before the fetch resolves: the Loading row gets the same treatment.
    expect(screen.getByText(/Loading/).closest('td')!.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
    const link = await screen.findByRole('link', { name: /Create your first loan/ });
    min(link, 'create link');
    expect(link.closest('td')!.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
  });
});
