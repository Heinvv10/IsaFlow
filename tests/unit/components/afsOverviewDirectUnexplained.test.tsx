/**
 * The direct statement closes on the ledger's cash; what its journals cannot explain (a cash leg on the year-end journal,
 * a posted journal that does not balance) is its own row, shown only when there is one, and never absorbed into a line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
const equity = {
  periodStart: '2026-01-01', periodEnd: '2026-12-31', columns: [],
  totalOpening: 0, totalProfitForYear: 0, totalDividends: 0, totalShareIssue: 0, totalRevaluation: 0, totalOtherMovements: 0, totalClosing: 0,
};
let unexplainedDifference = 0;
const direct = () => ({ operatingItems: [], investingItems: [], financingItems: [], operatingTotal: 0, investingTotal: 0, financingTotal: 0,
  openingCash: 0, unexplainedDifference, netChange: unexplainedDifference, closingCash: unexplainedDifference });
const reconciliation = { directClosing: 0, indirectClosing: 0, bankBalance: 0, variance: 0, isReconciled: true };
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify({ data: url.includes('changes-in-equity') ? { report: equity }
    : url.includes('cash-flow-direct') ? { report: direct() } : { reconciliation } }), { status: 200 })),
}));

import { AfsOverviewTab } from '@/components/accounting/afs/AfsOverviewTab';

afterEach(cleanup);
const props = { documentId: 'd1', periodStart: '2026-01-01', periodEnd: '2026-12-31' };

describe('AfsOverviewTab direct cash flow: unexplained difference', () => {
  it('shows a row for a difference the journals do not explain', async () => {
    unexplainedDifference = 400;
    render(<AfsOverviewTab {...props} />);
    expect(await screen.findByText(/Unexplained difference: the ledger/)).toBeTruthy();
  });
  it('shows no row when the journals explain the ledger cash', async () => {
    unexplainedDifference = 0;
    render(<AfsOverviewTab {...props} />);
    expect(await screen.findByText('Closing cash balance')).toBeTruthy();
    expect(screen.queryByText(/Unexplained difference/)).toBeNull();
  });
});
