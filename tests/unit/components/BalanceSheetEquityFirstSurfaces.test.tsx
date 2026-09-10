import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import ConsolidatedBalanceSheetPage from '@/../pages/accounting/group/balance-sheet';
import ThreeWayForecastPage from '@/../pages/accounting/reports/three-way-forecast';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

afterEach(() => {
  cleanup();
  vi.mocked(apiFetch).mockReset();
});

function comesBefore(first: HTMLElement, second: HTMLElement) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('balance-sheet presentation order', () => {
  it('renders Equity before Liabilities on the consolidated statement', async () => {
    vi.mocked(apiFetch).mockImplementation(async url => {
      if (String(url).includes('company-groups')) {
        return new Response(JSON.stringify({ data: [{ id: 'group-1', name: 'Group' }] }));
      }
      return new Response(JSON.stringify({ data: {
        rows: [
          { groupAccountCode: '1000', groupAccountName: 'Cash', section: 'assets', entities: {}, elimination: 0, consolidated: 300 },
          { groupAccountCode: '2000', groupAccountName: 'Payables', section: 'liabilities', entities: {}, elimination: 0, consolidated: 100 },
          { groupAccountCode: '3000', groupAccountName: 'Capital', section: 'equity', entities: {}, elimination: 0, consolidated: 200 },
        ],
        entityNames: {},
        totalAssets: { entities: {}, elimination: 0, consolidated: 300 },
        totalLiabilities: { entities: {}, elimination: 0, consolidated: 100 },
        totalEquity: { entities: {}, elimination: 0, consolidated: 200 },
        totalLiabilitiesAndEquity: { entities: {}, elimination: 0, consolidated: 300 },
      } }));
    });

    render(<ConsolidatedBalanceSheetPage />);
    const equity = await screen.findByText('Equity');
    const liabilities = screen.getByText('Liabilities');
    expect(comesBefore(equity, liabilities)).toBe(true);
    expect(screen.getAllByText('Total Equity and Liabilities')).toHaveLength(2);
  });

  it('renders Equity before Liabilities in the three-way forecast', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ data: { forecast: {
      months: [{
        month: 1, label: 'Apr',
        pnl: { revenue: 0, costOfSales: 0, grossProfit: 0, operatingExpenses: 0, ebit: 0, taxExpense: 0, netProfit: 0 },
        balanceSheet: { cash: 300, currentAssets: 300, totalAssets: 300, currentLiabilities: 100, totalLiabilities: 100, totalEquity: 200 },
        cashFlow: { operatingCashFlow: 0, investingCashFlow: 0, financingCashFlow: 0, netCashFlow: 0, closingCash: 300 },
      }],
      params: { revenueGrowthRate: 0, costOfSalesGrowthRate: 0, opexGrowthRate: 0, capitalExpenditure: 0 },
      generatedAt: '2026-04-01',
    } } })));

    render(<ThreeWayForecastPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Run Forecast' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Balance Sheet' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Balance Sheet' }));
    expect(comesBefore(screen.getByText('Total Equity'), screen.getByText('Total Liabilities'))).toBe(true);
  });
});
