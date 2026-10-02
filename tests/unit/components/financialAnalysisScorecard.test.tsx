// Financial Analysis's KPI tiles: value and target in the ratio's own unit, as every pack surface prints them.
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

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

const SCORECARD = [
  { ratioKey: 'grossProfitMargin', name: 'Gross Profit Margin', value: -1310.83, target: 35, status: 'red', percentOfTarget: -3745 },
  { ratioKey: 'debtorDays', name: 'Debtor Days', value: 213.23, target: 30, status: 'red', percentOfTarget: 711 },
  { ratioKey: 'currentRatio', name: 'Current Ratio', value: 2.4, target: 1.5, status: 'green', percentOfTarget: 160 },
  { ratioKey: 'interestCoverage', name: 'Interest Cover', value: 5.17, target: 3, status: 'green', percentOfTarget: 172 },
];

function serve(): void {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes('reports-kpi-scorecard')) return json({ scorecard: SCORECARD });
    if (u.includes('reports-ratio-trends')) return json({ trends: [] });
    return json({ ratios: null });
  });
}

const tile = async (name: string): Promise<string> => {
  const label = (await screen.findAllByText(name)).find((el) => el.closest('[data-kpi]'));
  expect(label, `no KPI tile is named ${name}`).toBeDefined();
  return (label!.closest('[data-kpi]') as HTMLElement).textContent!.replace(/[  ]/g, ' ');
};

describe('Financial Analysis KPI tiles', () => {
  it.each([
    ['Gross Profit Margin', '(1 310.8%)', 'Target: 35.0%'],
    ['Debtor Days', '213 days', 'Target: 30 days'],
    ['Current Ratio', '2.40', 'Target: 1.50'],
    ['Interest Cover', '5.17×', 'Target: 3.00×'],
  ])('%s prints %s against "%s"', async (name, value, target) => {
    serve();
    render(<FinancialAnalysisPage />);
    const text = await tile(name);
    expect(text).toContain(value);
    expect(text).toContain(target);
  }, 10000);
});
