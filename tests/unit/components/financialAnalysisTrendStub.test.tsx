// Financial Analysis: the ratio-trend chart labels the current month's stub "to date".
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
// The page loads its chart parts through next/dynamic; resolve each one once
// it has loaded, as the browser would.
vi.mock('next/dynamic', async () => {
  const React = await import('react');
  type Part = React.ComponentType<Record<string, unknown>>;
  return {
    default: (load: () => Promise<Part>) => function Loaded(props: Record<string, unknown>) {
      const [Part, setPart] = React.useState<Part | null>(null);
      React.useEffect(() => { void load().then((p) => setPart(() => p)); }, []);
      return Part ? React.createElement(Part, props) : null;
    },
  };
});
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
// jsdom gives ResponsiveContainer no size, so recharts draws nothing; the
// chart is stood in by the labels it is handed, which are what the axis and
// the tooltip print.
vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
    LineChart: ({ data }: { data: Array<{ period: string }> }) => (
      <ul data-chart="trend">{data.map((d) => <li key={d.period}>{d.period}</li>)}</ul>
    ),
    CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Line: () => null,
    BarChart: Pass, Bar: () => null, Cell: () => null, Legend: () => null,
  };
});
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import FinancialAnalysisPage from '../../../pages/accounting/reports/financial-analysis';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('FinancialAnalysisPage ratio trends', () => {
  it('marks the current month as to date, and only that month', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('reports-ratio-trends')) {
        return json({ trends: [{
          ratioName: 'debtorDays', trend: 'improving', changePercent: -3.23,
          values: [
            { period: 'Aug 2026', value: 6.2, partial: false },
            { period: 'Sep 2026', value: 6, partial: false },
            { period: 'Oct 2026', value: 0.4, partial: true },
          ],
        }] });
      }
      if (u.includes('reports-extended-ratios')) return json({ ratios: { notMeaningful: {} } });
      return json({ scorecard: [], summary: null });
    });
    render(<FinancialAnalysisPage />);

    expect(await screen.findByText('Oct 2026 (to date)')).toBeInTheDocument();
    expect(screen.getByText('Sep 2026')).toBeInTheDocument();
    expect(screen.queryByText('Sep 2026 (to date)')).toBeNull();
    expect(screen.queryByText('Oct 2026')).toBeNull();
  }, 10000);
});
