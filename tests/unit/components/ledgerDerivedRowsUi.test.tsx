// Derived rows (year-end closes) and the derived RE-BF account must not inflate counts, and must be labelled.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import GeneralLedgerPage from '../../../pages/accounting/reports/general-ledger';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('AccountDrillDown', () => {
  it('counts posted transactions only and italicises the derived close row', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({
      accountCode: '5000', accountName: 'Labour', openingBalance: 100, periodNet: 50, closingBalance: 5,
      transactions: [
        { date: '2025-02-10', entryNumber: 'JE1', description: 'wages', debit: 30, credit: 0, balance: 130, source: 'manual' },
        { date: '2025-02-28', entryNumber: '', description: 'Closed to retained earnings (derived — not posted)', debit: 0, credit: 130, balance: 0, source: 'year_end_close', derived: true },
        { date: '2025-03-05', entryNumber: 'JE2', description: 'wages', debit: 5, credit: 0, balance: 5, source: 'manual' },
      ],
    }));
    render(<AccountDrillDown accountCode="5000" periodStart="2025-01-01" periodEnd="2025-09-30" />);
    expect(await screen.findByText(/Closing Balance \(2 transactions\)/)).toBeTruthy();
    const derivedRow = screen.getByText(/derived — not posted/).closest('div[class*="italic"]');
    expect(derivedRow).not.toBeNull();
  }, 10000);
});

describe('General Ledger page', () => {
  const accounts = [
    { accountCode: '4000', accountName: 'Sales', accountType: 'revenue', openingBalance: 0, closingBalance: 10, totalDebit: 0, totalCredit: 10,
      transactions: [
        { date: '2025-02-10', entryNumber: 'JE1', description: 'sale', debit: 0, credit: 10, balance: 10, source: 'manual' },
        { date: '2025-02-28', entryNumber: '', description: 'Closed (derived — not posted)', debit: 10, credit: 0, balance: 0, source: 'year_end_close', derived: true },
      ] },
    { accountCode: '5000', accountName: 'Labour', accountType: 'expense', openingBalance: 0, closingBalance: 4, totalDebit: 4, totalCredit: 0, transactions: [] },
    { accountCode: 'RE-BF', accountName: 'Retained Earnings b/f (derived — not posted; profit before 2025-03-01)', accountType: 'equity',
      derived: true, openingBalance: 6, closingBalance: 6, totalDebit: 0, totalCredit: 0, transactions: [] },
  ];

  it('counts posted accounts only (RE-BF excluded), in the subtitle and the grand-totals line', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ accounts }));
    render(<GeneralLedgerPage />);
    expect(await screen.findByText(/2 accounts with activity in this period/)).toBeTruthy();
    expect(screen.getByText('GRAND TOTALS (2 accounts)')).toBeTruthy();
  }, 10000);

  it('labels the derived account', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ accounts }));
    render(<GeneralLedgerPage />);
    expect(await screen.findByText('derived — not posted')).toBeTruthy();
  }, 10000);
});
