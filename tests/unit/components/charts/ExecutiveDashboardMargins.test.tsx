/**
 * THE EXECUTIVE DASHBOARD'S MARGIN TILES SAY "n/m" AND WHY — NEVER 0.0%.
 *
 * The accountant view's Gross margin and Net margin tiles printed whatever
 * number the summary carried, which on nil revenue was 0 and on negative
 * revenue a sign-flipped margin. The summary now carries null and the
 * engine's reason; the tile prints "n/m" with the reason under it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// A canvas chart has nothing to say about a margin tile.
vi.mock('@/components/accounting/charts/CashPositionChart', () => ({ CashPositionChart: () => null }));
vi.mock('@/lib/apiFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apiFetch')>();
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from '@/lib/apiFetch';
import ExecutiveDashboardPage from '@/../pages/accounting/reports/executive-dashboard';

const REVENUE = 'Revenue is not positive, so this ratio has no meaning.';
const SCORECARD = [
  { ratioKey: 'grossProfitMargin', name: 'Gross Profit Margin', value: -1310.83, target: 35, status: 'red', percentOfTarget: -3745 },
  { ratioKey: 'debtorDays', name: 'Debtor Days', value: 213.23, target: 30, status: 'red', percentOfTarget: 711 },
  { ratioKey: 'currentRatio', name: 'Current Ratio', value: 0.58, target: 1.5, status: 'red', percentOfTarget: 39 },
];

function summary(margins: { gross: number | null; net: number | null }) {
  return {
    period: '2026-01-01 to 2026-09-07', companyName: 'Brightsphere',
    kpis: {
      revenue: -5_535_000, netProfit: -6_400_000, grossProfitMargin: margins.gross, netProfitMargin: margins.net,
      notMeaningful: margins.gross === null ? { grossProfitMargin: REVENUE, netProfitMargin: REVENUE } : {},
      revenueGrowth: 0, profitGrowth: 0, currentRatio: 0.58, debtToEquity: 1.2, cashBalance: 20_000,
    },
    cashPosition: { cashBalance: 20_000, accountsReceivable: 0, accountsPayable: 0, netWorkingCapital: -100_000, currentRatio: 0.58 },
    highlights: [], alerts: [],
  };
}

function serve(body: unknown): void {
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    if (url.includes('reports-executive-summary')) return new Response(JSON.stringify({ data: { summary: body } }), { status: 200 });
    if (url.includes('reports-kpi-scorecard')) return new Response(JSON.stringify({ data: { scorecard: SCORECARD } }), { status: 200 });
    return new Response(JSON.stringify({ data: { value: 'accountant' } }), { status: 200 });
  });
}

const tile = (label: string): HTMLElement => screen.getByText(label).closest('div.rounded-lg') as HTMLElement;

beforeEach(() => { window.localStorage.setItem('isaflow_reports_density', 'accountant'); });
afterEach(() => { cleanup(); vi.resetAllMocks(); window.localStorage.clear(); });

describe('the executive dashboard\'s margin tiles', () => {
  it('print n/m and the reason where the margins are not meaningful, and no percentage', async () => {
    serve(summary({ gross: null, net: null }));
    render(<ExecutiveDashboardPage />);
    await screen.findByText('Gross margin');
    for (const label of ['Gross margin', 'Net margin']) {
      const t = within(tile(label));
      expect(t.getByText('n/m')).toBeInTheDocument();
      expect(t.getByText(REVENUE)).toBeInTheDocument();
      expect(tile(label).textContent).not.toMatch(/%/);
    }
  });

  it('print a stated margin as a figure', async () => {
    serve(summary({ gross: 45.5, net: 12 }));
    render(<ExecutiveDashboardPage />);
    await screen.findByText('Gross margin');
    expect(within(tile('Gross margin')).getByText('45.5%')).toBeInTheDocument();
    expect(within(tile('Net margin')).queryByText('n/m')).toBeNull();
  });
});

describe('the executive dashboard\'s KPI scorecard tiles', () => {
  it.each([
    ['Gross Profit Margin', '(1 310.8%)', 'Target: 35.0%'],
    ['Debtor Days', '213 days', 'Target: 30 days'],
    ['Current Ratio', '0.58', 'Target: 1.50'],
  ])('%s prints %s against "%s"', async (name, value, target) => {
    serve(summary({ gross: 45.5, net: 12 }));
    render(<ExecutiveDashboardPage />);
    const label = await screen.findByText(name);
    const text = (label.closest('[data-kpi]') as HTMLElement).textContent!.replace(/[\u00a0\u202f]/g, ' ');
    expect(text).toContain(value);
    expect(text).toContain(target);
  });
});
