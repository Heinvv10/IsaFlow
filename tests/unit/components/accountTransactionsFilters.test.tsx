// Account Transactions page: every account that can carry postings is offered, and the cost-centre
// filter reaches the report and the export under the name the API reads (cost_centre_id).
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import AccountTransactionsPage from '../../../pages/accounting/reports/account-transactions';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
afterEach(() => { vi.mocked(apiFetch).mockReset(); vi.unstubAllGlobals(); });

const CC = '30000000-0000-4000-8000-000000000002';
const acct = (id: string, code: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, accountCode: code, accountName: name, accountType: 'asset', level: 3, hasTransactions: false, ...extra });
const chart = [
  acct('h1', '1000', 'Current assets header', { level: 1 }),                       // header: has a child, no postings
  acct('l1', '1010', 'Sage leaf at level 1', { level: 1, hasTransactions: true }), // Sage import: leaf at level 1
  acct('l2', '1020', 'Sage leaf at level 2', { level: 2 }),                       // level 2, childless
  acct('x1', '1030', 'Header at level 2', { level: 2 }),
  acct('x2', '1031', 'Child of the header', { level: 3, parentAccountId: 'x1' }),
  acct('k1', '1100', 'Bank', { level: 3, parentAccountId: 'h1' }),
];
const empty = { accountCode: '1100', accountName: 'Bank', accountType: 'asset', openingBalance: 0, closingBalance: 0, transactions: [] };

function script() {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes('chart-of-accounts')) return json(chart);
    if (u.includes('cost-centres')) return json({ items: [{ id: CC, code: 'CPT', name: 'Cape Town' }] });
    return json(empty);
  });
}

describe('AccountTransactionsPage account dropdown', () => {
  it('offers level 1-2 accounts that can carry postings and keeps headers out', async () => {
    script();
    render(<AccountTransactionsPage />);
    await screen.findByRole('option', { name: '1100 — Bank' });
    const options = screen.getAllByRole('option').map(o => o.textContent);
    expect(options).toContain('1010 — Sage leaf at level 1');   // level 1 with postings
    expect(options).toContain('1020 — Sage leaf at level 2');   // level 2, childless, no postings yet
    expect(options).toContain('1100 — Bank');
    expect(options).toContain('1031 — Child of the header');
    expect(options.join('|')).not.toContain('1000 — Current assets header');
    expect(options.join('|')).not.toContain('1030 — Header at level 2');
  });
});

describe('AccountTransactionsPage cost-centre filter', () => {
  it('sends cost_centre_id to the report and carries it, with every filter, into the export link', async () => {
    script();
    const location = { href: '' };
    vi.stubGlobal('location', location);
    render(<AccountTransactionsPage />);
    await screen.findByText(/CPT — Cape Town/);
    fireEvent.change(screen.getByDisplayValue('All Cost Centres'), { target: { value: CC } });
    await waitFor(() => {
      const urls = vi.mocked(apiFetch).mock.calls.map(c => String(c[0])).filter(u => u.includes('reports-account-transactions'));
      expect(urls.at(-1)).toContain(`cost_centre_id=${CC}`);
      expect(urls.at(-1)).not.toMatch(/[?&]cost_centre=/);
    });
    await waitFor(() => expect((screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    const link = new URL(location.href, 'http://x');
    expect(link.pathname).toBe('/api/accounting/account-transactions-export');
    expect(link.searchParams.get('cost_centre_id')).toBe(CC);
    expect(link.searchParams.get('account_code')).toBe('1110');
    expect(link.searchParams.get('period_start')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(link.searchParams.get('period_end')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
