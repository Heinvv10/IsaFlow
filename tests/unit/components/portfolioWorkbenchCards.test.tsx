// Portfolio workbench: the clients-by-checks grid becomes labelled cards below lg; the client button and filter are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, asPath: '/', isReady: true, push: vi.fn(), replace: vi.fn() }) }));
const card = (id: string) => ({ id, title: id, status: 'ready', primary: 'ok' });
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: {
      userId: 'u1', period: '2026-11', generatedAt: '2026-11-22T10:00:00Z',
      summary: { totalClients: 2, clientsAtRisk: 0, cardsByStatus: {} },
      rows: [
        { companyId: 'c1', companyName: 'Acme (Pty) Ltd', isDefault: true, role: 'owner', trialBalanceBalanced: true, readyCount: 8, attentionCount: 0, blockedCount: 0, failed: false,
          cards: ['banking', 'sales', 'purchases', 'vat', 'payroll', 'afs', 'exceptions', 'review'].map(card) },
        // No payroll access and a missing card: both fallback cells must carry their label too.
        { companyId: 'c2', companyName: 'Beta CC', isDefault: false, role: 'accountant', trialBalanceBalanced: false, readyCount: 3, attentionCount: 1, blockedCount: 0, failed: false, payrollHidden: true,
          cards: ['banking', 'sales', 'vat'].map(card) },
      ],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/portfolio-workbench';

afterEach(cleanup);
const LABELS = ['TB', 'Bank', 'AR', 'AP', 'VAT', 'Payroll', 'AFS', 'Exceptions', 'Review', 'Ready'];
const labels = (row: Element) => [...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'));

describe('Portfolio workbench on touch', () => {
  it('turns the grid into labelled cards; the client cell has no label so it heads the card', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Acme (Pty) Ltd');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(['Client', ...LABELS]);
    const rows = [...table.querySelectorAll(':scope > tbody > tr')];
    expect(rows).toHaveLength(2);
    // Every cell of every row is labelled, including the "No access" and "—" fallbacks.
    for (const row of rows) expect(labels(row)).toEqual([null, ...LABELS]);
  });

  it('makes the client button and the filter 44px, centred against the heading', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Acme (Pty) Ltd');
    const btn = screen.getByRole('button', { name: 'Acme (Pty) Ltd' });
    expect(btn.className).toContain('max-lg:min-h-11');
    const filter = screen.getByRole('searchbox', { name: 'Filter clients' });
    // w-48 beside the period field overflowed a 360px phone: the filter takes the row and the period wraps below it.
    for (const c of ['max-lg:min-h-11', 'max-lg:w-full']) expect(filter.className.split(' ')).toContain(c);
    expect(filter.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:w-full', 'max-lg:flex-wrap']));
    expect(container.querySelector('tbody tr td')!.getAttribute('data-label')).toBeNull();
  });
});
