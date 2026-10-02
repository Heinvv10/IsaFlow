// Financial Analysis: a ratio the engine could not state prints its reason, never 0 and never a crash.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import FinancialAnalysisPage from '../../../pages/accounting/reports/financial-analysis';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

/** Reversals exceed sales, no capex is supplied, and equity is negative: the
 *  engine's own answer for that company, as the API returns it. */
const RATIOS = calculateExtendedRatios({
  revenue: -5_535_000, costOfSales: 0, operatingExpenses: 600_000, netProfit: -1_407_000, operatingProfit: -1_819_000,
  totalAssets: 3_192_000, totalLiabilities: 3_600_000, totalEquity: -408_000,
  currentAssets: 3_000_000, currentLiabilities: 1_500_000,
  inventory: 0, accountsReceivable: -330_000, accountsPayable: 200_000, cash: 2_500_000,
  operatingCashFlow: 250_000,
});

function serve(): void {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes('reports-extended-ratios')) return json({ ratios: RATIOS });
    if (u.includes('reports-ratio-trends')) {
      return json({ trends: [{ ratioName: 'grossProfitMargin', values: [{ period: 'P1', value: null }], trend: 'not_meaningful', changePercent: null }] });
    }
    return json({ scorecard: [], summary: null });
  });
}

/** The ratio row carrying `label` — the trend panels repeat some names. */
const row = async (label: string): Promise<string> => {
  const hits = (await screen.findAllByText(label)).map((el) => el.closest('[data-ratio]')).filter(Boolean);
  expect(hits, `no ratio row is labelled ${label}`).toHaveLength(1);
  return (hits[0] as HTMLElement).textContent ?? '';
};

describe('FinancialAnalysisPage ratios', () => {
  it('prints the reason for a margin on negative revenue, not "100"', async () => {
    serve();
    render(<FinancialAnalysisPage />);
    const text = await row('Gross Profit Margin');
    expect(text).toContain('Revenue is not positive, so this ratio has no meaning.');
    expect(text).not.toMatch(/100/);
  }, 10000);

  it('prints the reason for free cash flow where no capital expenditure is supplied, not 0', async () => {
    serve();
    render(<FinancialAnalysisPage />);
    const text = await row('Free Cash Flow');
    expect(text).toContain('capital expenditure is not captured separately');
    expect(text).not.toMatch(/\b0(\.00)?\b/);
  }, 10000);

  it('names ratios in words and writes figures in their unit', async () => {
    serve();
    render(<FinancialAnalysisPage />);
    expect(await row('Current Ratio')).toContain('2.00');
    expect(await row('Return on Capital Employed (ROCE)')).toMatch(/\(107\.5%\)|−107\.5%|-107\.5%/);
    expect(screen.queryByText('Roce')).toBeNull();
    expect(screen.queryByText('Ebitda Margin')).toBeNull();
  }, 10000);
});
