/**
 * The Overview tab's equity statement names its profit row after the period it covers: "Profit for year" for twelve
 * months, "Profit for the period" for a transition year (or when the length is not known).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
const report = {
  periodStart: '2026-01-01', periodEnd: '2027-02-28',
  columns: [{ subtype: 'retained_earnings', label: 'Retained Earnings', opening: 0, profitForYear: 5, dividends: 0, shareIssue: 0, revaluation: 0, otherMovements: 0, closing: 5 }],
  totalOpening: 0, totalProfitForYear: 5, totalDividends: 0, totalShareIssue: 0, totalRevaluation: 0, totalOtherMovements: 0, totalClosing: 5,
};
const direct = { operatingItems: [], investingItems: [], financingItems: [], operatingTotal: 0, investingTotal: 0, financingTotal: 0, openingCash: 0, netChange: 0, closingCash: 0 };
const reconciliation = { directClosing: 0, indirectClosing: 0, bankBalance: 0, variance: 0, isReconciled: true };
const answers = (url: string) => url.includes('changes-in-equity') ? { report }
  : url.includes('cash-flow-direct') ? { report: direct } : { reconciliation };
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify({ data: answers(url) }), { status: 200 })),
}));

import { AfsOverviewTab } from '@/components/accounting/afs/AfsOverviewTab';

afterEach(cleanup);
const props = { documentId: 'd1', periodStart: '2026-01-01', periodEnd: '2027-02-28' };

describe('AfsOverviewTab profit row label', () => {
  it('twelve months (the default): "Profit for year"', async () => {
    render(<AfsOverviewTab {...props} />);
    expect(await screen.findByText('Profit for year')).toBeTruthy();
  });
  it('a 14-month transition year: "Profit for the period"', async () => {
    render(<AfsOverviewTab {...props} periodMonths={14} />);
    expect(await screen.findByText('Profit for the period')).toBeTruthy();
    expect(screen.queryByText('Profit for year')).toBeNull();
  });
  it('a period of unknown length: "Profit for the period"', async () => {
    render(<AfsOverviewTab {...props} periodMonths={null} />);
    expect(await screen.findByText('Profit for the period')).toBeTruthy();
  });
});
