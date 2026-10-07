// Financial Analysis: the ratio-trend chart labels the current month's stub "to date".
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { render, screen, waitFor } from '@testing-library/react';
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
// jsdom gives ResponsiveContainer no size, so recharts draws nothing. The
// chart is stood in by what it hands the axis and the tooltip: each point's
// tick label and tooltip title, through the chart's own formatters. Whether
// the tick then FITS is a question for a real browser — see
// tests/unit/print/ratioTrendTicks.test.ts.
vi.mock('recharts', async () => {
  const React = await import('react');
  type Point = { period: string };
  type Fmt = (p: string) => string;
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
    LineChart: ({ data, children }: { data: Point[]; children?: ReactNode }) => (
      <div>{React.Children.map(children, (c) => (React.isValidElement(c)
        ? React.cloneElement(c as React.ReactElement<{ points?: Point[] }>, { points: data }) : c))}</div>
    ),
    XAxis: ({ points, tickFormatter }: { points: Point[]; tickFormatter: Fmt }) => (
      <ul data-axis="x">{points.map((p) => <li key={p.period}>{tickFormatter(p.period)}</li>)}</ul>
    ),
    Tooltip: ({ points, labelFormatter }: { points: Point[]; labelFormatter: Fmt }) => (
      <ul data-tooltip="">{points.map((p) => <li key={p.period}>{labelFormatter(p.period)}</li>)}</ul>
    ),
    CartesianGrid: () => null, YAxis: () => null, Line: () => null,
  };
});
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import FinancialAnalysisPage from '../../../pages/accounting/reports/financial-analysis';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

const TREND = (partial: boolean) => ({
  ratioName: 'debtorDays', trend: 'improving', changePercent: -3.23,
  values: [
    { period: 'Aug 2026', value: 6.2, partial: false },
    { period: 'Sep 2026', value: 6, partial: false },
    { period: 'Oct 2026', value: 0.4, partial },
  ],
});

function serve(partial: boolean): void {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes('reports-ratio-trends')) return json({ trends: [TREND(partial)] });
    if (u.includes('reports-extended-ratios')) return json({ ratios: { notMeaningful: {} } });
    return json({ scorecard: [], summary: null });
  });
}

const texts = (selector: string): string[] => [...document.querySelectorAll(`${selector} li`)].map((li) => li.textContent ?? '');

describe('FinancialAnalysisPage ratio trends', () => {
  it('marks the current month on the axis, names it in the tooltip, and explains the mark', async () => {
    serve(true);
    render(<FinancialAnalysisPage />);

    expect(await screen.findByText('* The current month, to date.')).toBeInTheDocument();
    await waitFor(() => expect(texts('[data-axis="x"]')).toEqual(['Aug 2026', 'Sep 2026', 'Oct 2026*']));
    expect(texts('[data-tooltip]')).toEqual(['Aug 2026', 'Sep 2026', 'Oct 2026 (to date)']);
  }, 10000);

  it('marks nothing, and explains nothing, where every month is whole', async () => {
    serve(false);
    render(<FinancialAnalysisPage />);

    await waitFor(() => expect(texts('[data-axis="x"]')).toEqual(['Aug 2026', 'Sep 2026', 'Oct 2026']));
    expect(screen.queryByText('* The current month, to date.')).toBeNull();
  }, 10000);
});
