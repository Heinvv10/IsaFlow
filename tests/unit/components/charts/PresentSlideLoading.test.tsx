/**
 * Loading is not failure.
 *
 * `[pack].tsx` renders the deck as soon as the PACK fetch resolves, which is
 * before the trends, budget and income-statement fetches behind it have
 * landed. Without an explicit in-flight state the income slide said "could
 * not be loaded" and the trends slide said "no presentation renderer yet"
 * about requests that were still running — two statements nobody had checked,
 * on a boardroom screen.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PresentSlide } from '@/components/accounting/present/PresentSlide';
import type { Slide } from '@/components/accounting/present/presentSlides';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import type { AccountTrends } from '@/modules/accounting/services/reports/trendRowsService';

afterEach(cleanup);

const INCOME_SLIDE: Slide = { id: 'is:0', kind: 'income_statement', title: 'Income Statement', data: {} };
const TRENDS_SLIDE: Slide = { id: 'trends:0', kind: 'trends', title: 'Trends', data: {} };
const RATIOS_SLIDE: Slide = { id: 'ratios:0', kind: 'ratios', title: 'Ratios', data: {} };

const BASE = {
  income: null, trends: null, trendsFailed: false,
  budget: [] as BudgetVsActualLine[], budgetedCount: 0, budgetFailed: false,
};

const INCOME: IncomeStatementReport = {
  periodStart: '2026-01-01', periodEnd: '2026-01-31',
  revenue: [{ accountCode: '4000', accountName: 'Sales', amount: 900_000 }],
  otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
  totalRevenue: 900_000, totalOtherIncome: 0, totalCostOfSales: 0,
  totalOperatingExpenses: 0, totalOtherExpenses: 0,
  grossProfit: 900_000, operatingProfit: 900_000, netProfit: 900_000,
};

const TRENDS: AccountTrends = {
  months: ['2026-01', '2026-02'],
  byAccountCode: { '4000': [1, 2] },
  unavailable: {},
};

const BUDGET: BudgetVsActualLine[] = [{
  account_code: '4000', account_name: 'Sales', account_type: 'revenue',
  budget_amount: 1_000_000, actual_amount: 900_000, variance: -100_000, variance_pct: -10,
}];

describe('the income-statement slide', () => {
  it('says it is loading while the fetch is in flight', () => {
    const { container } = render(<PresentSlide slide={INCOME_SLIDE} {...BASE} incomeLoading />);
    expect(container.textContent).toContain('Loading the income statement');
    expect(container.textContent).not.toContain('could not be loaded');
  });

  it('says it failed once the fetch has settled with nothing', () => {
    const { container } = render(<PresentSlide slide={INCOME_SLIDE} {...BASE} />);
    expect(container.textContent).toContain('could not be loaded');
    expect(container.textContent).not.toContain('Loading the income statement');
  });

  it('draws the statement once it has loaded', () => {
    const { container } = render(<PresentSlide slide={INCOME_SLIDE} {...BASE} income={INCOME} />);
    expect(container.textContent).toContain('Sales');
    expect(container.textContent).not.toContain('could not be loaded');
  });
});

describe('the trends slide', () => {
  it('says it is loading rather than "no presentation renderer yet"', () => {
    const { container } = render(<PresentSlide slide={TRENDS_SLIDE} {...BASE} trendsLoading />);
    expect(container.textContent).toContain('Loading the trend data');
    expect(container.textContent).not.toContain('no presentation renderer');
  });

  it('says it failed once the fetch has rejected', () => {
    const { container } = render(<PresentSlide slide={TRENDS_SLIDE} {...BASE} trendsFailed />);
    expect(container.textContent).toContain('could not be loaded');
    expect(container.textContent).not.toContain('Loading the trend data');
  });

  it('draws the panels once they have loaded', () => {
    const { container } = render(<PresentSlide slide={TRENDS_SLIDE} {...BASE} trends={TRENDS} />);
    expect(container.textContent).toContain('Twelve months by account');
  });
});

describe('the ratios slide', () => {
  it('says it is loading rather than "no budget was captured"', () => {
    const { container } = render(<PresentSlide slide={RATIOS_SLIDE} {...BASE} budgetLoading />);
    expect(container.textContent).toContain('Loading the budget data');
    expect(container.textContent).not.toContain('No budget was captured');
  });

  it('says it failed once the fetch has rejected', () => {
    const { container } = render(<PresentSlide slide={RATIOS_SLIDE} {...BASE} budgetFailed />);
    expect(container.textContent).toContain('could not be loaded');
    expect(container.textContent).not.toContain('Loading the budget data');
  });

  it('says no budget was captured once the fetch has landed empty', () => {
    const { container } = render(<PresentSlide slide={RATIOS_SLIDE} {...BASE} />);
    expect(container.textContent).toContain('No budget was captured');
  });

  it('draws the bullets once a real budget has loaded', () => {
    const { container } = render(
      <PresentSlide slide={RATIOS_SLIDE} {...BASE} budget={BUDGET} budgetedCount={1} />,
    );
    expect(container.textContent).toContain('Budget variance');
  });
});

// ── The page wiring: the deck appears before the three fetches land ───────
const push = vi.fn();
let query: Record<string, string> = {};
vi.mock('next/router', () => ({ useRouter: () => ({ query, isReady: true, push }) }));

const apiJson = vi.fn();
vi.mock('@/lib/apiFetch', () => ({ apiJson: (...args: unknown[]) => apiJson(...args) }));

// eslint-disable-next-line import/first
import PresentPackPage from '@/../pages/accounting/reports/present/[pack]';

describe('the pack page between the pack fetch and the comparator fetches', () => {
  afterEach(() => { query = {}; apiJson.mockReset(); });

  it('shows the income slide as loading, not as failed', async () => {
    let releaseIncome: (v: unknown) => void = () => {};
    apiJson.mockImplementation(async (url: string) => {
      if (url.includes('reports-pack')) {
        return {
          pack: {
            type: 'management', companyName: 'Acme', period: '2026-01',
            generatedAt: '2026-01-31',
            sections: [{ type: 'income_statement', title: 'Income Statement', data: {} }],
          },
        };
      }
      if (url.includes('reports-account-trends')) return { months: [], byAccountCode: {}, unavailable: {} };
      if (url.includes('reports-budget-comparator')) return { lines: [], budgetedCount: 0 };
      // The income statement never settles for the duration of this test.
      return new Promise((resolve) => { releaseIncome = resolve; });
    });

    query = { pack: 'management', from: '2026-01-01', to: '2026-01-31' };
    render(<PresentPackPage />);

    // The cover is slide 1; page forward to the income slide.
    expect(await screen.findByText('Acme — Management Pack')).toBeInTheDocument();
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(await screen.findByText(/Loading the income statement/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    releaseIncome(undefined);
  });
});
