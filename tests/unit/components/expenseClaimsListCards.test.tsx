// Expense claims list: the table becomes labelled cards below lg; the header controls (status filter, refresh, New claim) and the empty-state link are 44px; the header wraps.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ claims: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { claims: state.claims } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/expenses/index';

const claim = (id: string, n: string) => ({ id, claimNumber: n, claimDate: '2026-11-18', employeeId: 'emp1', title: 'Client lunch', status: 'submitted', totalAmount: 460, totalVat: 60, createdAt: '2026-11-18T08:00:00Z' });
afterEach(() => { cleanup(); state.claims = []; });
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const HEADS = ['Claim', 'Date', 'Title', 'Status', 'VAT', 'Total'];

describe('Expense claims list on touch', () => {
  it('turns the table into labelled cards matching its headers', async () => {
    state.claims = [claim('c1', 'EXP-0001'), claim('c2', 'EXP-0002')];
    const { container } = render(<Page />);
    await screen.findByText('EXP-0001');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    for (const row of table.querySelectorAll('tbody tr')) {
      const cells = [...row.querySelectorAll('td')];
      expect(cells.map((td) => td.getAttribute('data-label'))).toEqual([null, 'Date', 'Title', 'Status', 'VAT', 'Total']); // the claim number is the card's heading
    }
  });

  it('the header controls are 44px and the refresh button has a name', async () => {
    state.claims = [claim('c1', 'EXP-0001')];
    const { container } = render(<Page />);
    await screen.findByText('EXP-0001');
    expect(cls(container.querySelector('select')!)).toContain(MIN);
    expect(cls(screen.getByRole('button', { name: 'Refresh' }))).toEqual(expect.arrayContaining([MIN, 'max-lg:min-w-11', 'max-lg:justify-center']));
    expect(cls(screen.getByRole('link', { name: /New claim/ }))).toContain(MIN);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(cls(h1.parentElement!.parentElement!)).toContain('max-lg:flex-wrap');
    expect(cls(screen.getByRole('button', { name: 'Refresh' }).parentElement!)).toContain('max-lg:flex-wrap');
  });

  it('the empty state\'s "Create your first claim" link is 44px', async () => {
    render(<Page />);
    expect(cls(await screen.findByRole('link', { name: /Create your first claim/ }))).toContain(MIN); // already inline-flex items-center
  });
});
