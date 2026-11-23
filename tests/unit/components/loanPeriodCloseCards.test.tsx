// Loan period close: the loans table becomes labelled cards below lg; header, selects, Post All, row Post and the loan link are 44px; the actions cell hides when it would be empty.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ loans: [] as unknown[], locked: false }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { yyyymm: '202611', month: 11, year: 2026, locked: state.locked, loans: state.loans } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/loans/period-close';

const loan = (id: string, status: 'open' | 'posted') => ({ loanId: id, reference: `LN-${id}`, description: 'Mortgage bond on the Phalaborwa depot property', product: 'bond', principalBalance: 5000000, rateMode: 'PRIME_PLUS', margin: 1.5, fixedRate: null, nextPaymentDate: '2026-12-01', accruedInterest: 48000, periodStatus: status });
afterEach(() => { cleanup(); state.locked = false; state.loans = [loan('1', 'open'), loan('2', 'posted')]; });
state.loans = [loan('1', 'open'), loan('2', 'posted')];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Loan / Borrower', 'Principal Balance', 'Rate', 'Next Payment', 'Accrued Interest', 'Status', ''];

describe('Loan period close on touch', () => {
  it('turns the table into labelled cards: the loan cell and the actions cell carry no label', async () => {
    const { container } = render(<Page />);
    await screen.findByText('LN-1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const tr of rows) expect([...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, 'Principal Balance', 'Rate', 'Next Payment', 'Accrued Interest', 'Status', null]);
  });

  it('Post and the loan link are 44px; the description wraps; the actions cell hides when locked (no Post, not posted)', async () => {
    const unlocked = render(<Page />);
    await screen.findByText('LN-1');
    expect(unlocked.container.querySelector('tbody tr:first-child > td:last-child')!.className).toBe('px-4 py-3 text-right'); // open and unlocked: the Post cell stays, desktop classes exactly as before
    expect(cls(screen.getByRole('button', { name: 'Post' }))).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('link', { name: 'LN-1' }))).toEqual(expect.arrayContaining(['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11']));
    expect(cls(screen.getAllByText(/Mortgage bond/, { selector: 'div' })[0])).toEqual(expect.arrayContaining(['max-lg:max-w-none', 'max-lg:whitespace-normal']));
    cleanup(); state.locked = true;
    const again = render(<Page />);
    await screen.findByText('LN-1');
    const open = again.container.querySelector('tbody tr:first-child > td:last-child')!;
    expect(open.childNodes).toHaveLength(0);
    expect(cls(open)).toContain('max-lg:!hidden');
    expect(cls(again.container.querySelector('tbody tr:last-child > td:last-child')!)).not.toContain('max-lg:!hidden'); // the posted row still shows Done
  });

  it('header: back link 44px square, wrapping selects 44px; Post All 44px; empty-state link 44px', async () => {
    const { container } = render(<Page />);
    await screen.findByText('LN-1');
    expect(cls(container.querySelector('a[href="/accounting/loans"]')!)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']));
    for (const s of container.querySelectorAll('select')) expect(cls(s)).toContain('max-lg:min-h-11');
    expect(container.querySelectorAll('select')).toHaveLength(2);
    expect(cls(container.querySelector('select')!.parentElement!)).toContain('max-lg:flex-wrap');
    expect(cls(screen.getByRole('button', { name: /Post All Unposted/ }))).toContain('max-lg:min-h-11');
    cleanup(); state.loans = [];
    render(<Page />);
    const create = await screen.findByRole('link', { name: 'Create a loan' });
    expect(cls(create.closest('td')!)).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8'])); // the empty-state cell
    expect(cls(create)).toEqual(expect.arrayContaining(['max-lg:inline-flex', 'max-lg:items-center', 'max-lg:min-h-11']));
  });
});
