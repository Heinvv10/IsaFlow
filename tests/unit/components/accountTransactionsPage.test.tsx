// Account Transactions page: a derived year-end close row is labelled and left out of TOTAL Dr/Cr.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import AccountTransactionsPage from '../../../pages/accounting/reports/account-transactions';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

// Expense account, FY start 1 March: opening 100, +30 (130), CLOSE 130, +5 (5).
const report = {
  accountCode: '1110', accountName: 'Labour', accountType: 'expense', openingBalance: 100, periodNet: 35, closingBalance: 5,
  transactions: [
    { date: '2025-02-10', entryNumber: 'JE1', description: 'wages', debit: 30, credit: 0, balance: 130, source: 'manual' },
    { date: '2025-02-28', entryNumber: '', description: 'Closed to retained earnings (derived — not posted)', debit: 0, credit: 130, balance: 0, source: 'year_end_close', derived: true },
    { date: '2025-03-05', entryNumber: 'JE2', description: 'wages', debit: 5, credit: 0, balance: 5, source: 'manual' },
  ],
};

describe('AccountTransactionsPage across a fiscal-year start', () => {
  it('totals only posted rows and italicises the derived close row', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
      String(url).includes('reports-account-transactions') ? json(report) : json({ items: [], accounts: [] }));
    render(<AccountTransactionsPage />);
    const totalRow = (await screen.findByText('TOTAL')).closest('tr')!;
    expect(totalRow.textContent).toContain(fmt(35));          // posted debits 30 + 5
    expect(totalRow.textContent).not.toContain(fmt(130));     // the derived close credit must not be a total
    const derivedRow = screen.getByText(/derived — not posted/).closest('tr')!;
    expect(derivedRow.className).toContain('italic');
  }, 10000);
});
