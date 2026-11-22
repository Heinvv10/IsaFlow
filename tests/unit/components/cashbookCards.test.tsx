// Cashbook: the transactions table becomes labelled cards below lg and the controls are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiJson: vi.fn(async () => [{ id: 'b1', accountName: 'Cheque', accountCode: '1100' }]),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: [
      { id: 't1', transactionDate: '2026-05-01', reference: 'REF1', description: 'Customer deposit', amount: 500 },
      { id: 't2', transactionDate: '2026-05-02', reference: '', description: 'Rent', amount: -200 },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/cashbook';

afterEach(cleanup);
const LABELS = ['Date', 'Reference', 'Description', 'Deposits', 'Withdrawals', 'Balance'];

describe('Cashbook on touch', () => {
  it('turns the table into labelled cards whose labels equal the headers', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Customer deposit');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(LABELS);
    const rows = [...table.querySelectorAll(':scope > tbody > tr')];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual(LABELS);
    // Totals row: the TOTALS cell spans the card (no label); the sums keep theirs.
    const foot = [...table.querySelectorAll(':scope > tfoot > tr > td')];
    expect(foot.map(td => td.getAttribute('data-label'))).toEqual([null, 'Deposits', 'Withdrawals', 'Balance']);
  });

  it('makes the bank select, header wrap and Export CSV 44px on phones', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Customer deposit');
    expect(container.querySelector('select')!.className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('button', { name: /export csv/i }).className).toContain('max-lg:min-h-11');
    expect(container.querySelector('h1')!.closest('.flex.items-center.justify-between')!.className).toContain('max-lg:flex-wrap');
  });
});
