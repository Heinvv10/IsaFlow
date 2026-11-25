// Opening balances: the account grid becomes labelled cards below lg; the amount inputs, Save and the totals strip are phone-sized.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: { accounts: [
      { id: 'a1', account_code: '1000', account_name: 'Bank', account_type: 'asset', normal_balance: 'debit', opening_debit: 100, opening_credit: 0 },
      { id: 'a2', account_code: '3000', account_name: 'Capital', account_type: 'equity', normal_balance: 'credit', opening_debit: 0, opening_credit: 100 },
    ] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/opening-balances/index';

afterEach(cleanup);
const HEADS = ['Code', 'Account Name', 'Type', 'Debit', 'Credit'];

describe('Opening balances on touch', () => {
  it('turns the account table into labelled cards whose labels equal the headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Capital');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll(':scope > tbody > tr')];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([...r.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('makes every amount input 44px and shrinkable beside its label, centred in its row', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Capital');
    const inputs = [...container.querySelectorAll('tbody input')];
    expect(inputs).toHaveLength(4); // debit + credit for two accounts
    for (const i of inputs) {
      for (const c of ['max-lg:min-h-11', 'max-lg:w-auto', 'max-lg:min-w-0', 'max-lg:flex-1']) expect(i.className.split(' '), c).toContain(c);
      expect(i.closest('td')!.className).toContain('max-lg:items-center');
    }
  });

  it('makes Save 44px, wraps the header and stacks the totals strip', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Capital');
    expect(screen.getByRole('button', { name: /Save Opening Balances/ }).className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
    expect(screen.getByRole('button', { name: /Save Opening Balances/ }).parentElement!.className).toContain('max-lg:flex-wrap');
    // Three "Total Debits: R 1 234 567.89" cells do not fit three-across on a phone.
    expect(container.querySelector('.grid-cols-3')!.className).toContain('max-lg:grid-cols-1');
  });
});
