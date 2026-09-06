/**
 * The small-multiples panels on the trends slide were titled with the account
 * CODE alone. A boardroom is not the finance team, and "4000" names nothing
 * to it. The names come from the income statement the deck already fetched.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { PresentSlide } from '@/components/accounting/present/PresentSlide';
import type { Slide } from '@/components/accounting/present/presentSlides';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import type { AccountTrends } from '@/modules/accounting/services/reports/trendRowsService';

vi.mock('@/components/charts/EChartClient', () => ({
  EChartClient: ({ height }: { height: number }) => <div data-testid="echart" data-height={height} />,
}));

const buildOption = vi.fn();
vi.mock('@/components/accounting/charts/smallMultiplesOption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/accounting/charts/smallMultiplesOption')>();
  return {
    ...actual,
    buildSmallMultiplesOption: (...args: Parameters<typeof actual.buildSmallMultiplesOption>) => {
      buildOption(...args);
      return actual.buildSmallMultiplesOption(...args);
    },
  };
});

afterEach(() => { cleanup(); buildOption.mockReset(); });

const TRENDS_SLIDE: Slide = { id: 'trends:0', kind: 'trends', title: 'Trends', data: {} };

const TRENDS: AccountTrends = {
  months: ['2026-01', '2026-02'],
  byAccountCode: { '4000': [1, 2], '9999': [3, 4] },
  unavailable: {},
};

const INCOME: IncomeStatementReport = {
  periodStart: '2026-01-01', periodEnd: '2026-02-28',
  revenue: [{ accountCode: '4000', accountName: 'Sales', amount: 900_000 }],
  otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
  totalRevenue: 900_000, totalOtherIncome: 0, totalCostOfSales: 0,
  totalOperatingExpenses: 0, totalOtherExpenses: 0,
  grossProfit: 900_000, operatingProfit: 900_000, netProfit: 900_000,
};

const BASE = {
  income: null, trends: null, trendsFailed: false,
  budget: [], budgetedCount: 0, budgetFailed: false,
};

const labels = () => (buildOption.mock.calls[0]?.[0] as Array<{ label: string }>).map(p => p.label);

describe('the trends slide panels', () => {
  it('titles a panel with its code and its name', () => {
    render(<PresentSlide slide={TRENDS_SLIDE} {...BASE} income={INCOME} trends={TRENDS} />);
    expect(labels()).toContain('4000 · Sales');
  });

  it('keeps the code alone when no line names that account', () => {
    // Better a bare code than a name borrowed from somewhere it may not
    // belong to.
    render(<PresentSlide slide={TRENDS_SLIDE} {...BASE} income={INCOME} trends={TRENDS} />);
    expect(labels()).toContain('9999');
  });

  it('fills the slide rather than sizing the grid to two rows of panels', () => {
    const { getByTestId } = render(
      <PresentSlide slide={TRENDS_SLIDE} {...BASE} income={INCOME} trends={TRENDS} />,
    );
    // Two panels would otherwise size the frame to one row: 1 * 130 + 40.
    expect(getByTestId('echart').getAttribute('data-height')).toBe('480');
  });
});
