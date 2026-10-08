// Financial Analysis: the ratio-trend chart labels the current month's stub "to date".
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  type Point = Record<string, unknown>;
  type Title = (label: unknown, payload: Array<{ payload: Point }>) => string;
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    ResponsiveContainer: Pass,
    LineChart: ({ data, children }: { data: Point[]; children?: ReactNode }) => (
      <div>{React.Children.map(children, (c) => (React.isValidElement(c)
        ? React.cloneElement(c as React.ReactElement<{ points?: Point[] }>, { points: data }) : c))}</div>
    ),
    XAxis: ({ points, dataKey }: { points: Point[]; dataKey: string }) => (
      <ul data-axis="x">{points.map((p, i) => <li key={i}>{String(p[dataKey])}</li>)}</ul>
    ),
    Tooltip: ({ points, labelFormatter }: { points: Point[]; labelFormatter: Title }) => (
      <ul data-tooltip="">{points.map((p, i) => <li key={i}>{labelFormatter(p['axisLabel'], [{ payload: p }])}</li>)}</ul>
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
    // And a screen reader is told what the mark means.
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('* The current month, to date.');
    expect(note.className).toContain('text-[var(--ff-text-secondary)]');
    expect(document.querySelector('[data-trend="debtorDays"]')!.getAttribute('aria-describedby')).toBe(note.id);
  }, 10000);

  it('marks nothing, and explains nothing, where every month is whole', async () => {
    serve(false);
    render(<FinancialAnalysisPage />);

    await waitFor(() => expect(texts('[data-axis="x"]')).toEqual(['Aug 2026', 'Sep 2026', 'Oct 2026']));
    expect(screen.queryByText('* The current month, to date.')).toBeNull();
    expect(document.querySelector('[data-trend="debtorDays"]')!.hasAttribute('aria-describedby')).toBe(false);
  }, 10000);

  it('marks a stub by its own flag, even where another point shares its label', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('reports-ratio-trends')) {
        return json({ trends: [{ ...TREND(true), values: [
          { period: 'Oct 2026', value: 6.2, partial: false },
          { period: 'Oct 2026', value: 0.4, partial: true },
        ] }] });
      }
      if (u.includes('reports-extended-ratios')) return json({ ratios: { notMeaningful: {} } });
      return json({ scorecard: [], summary: null });
    });
    render(<FinancialAnalysisPage />);

    await waitFor(() => expect(texts('[data-axis="x"]')).toEqual(['Oct 2026', 'Oct 2026*']));
    expect(texts('[data-tooltip]')).toEqual(['Oct 2026', 'Oct 2026 (to date)']);
  }, 10000);
});

/** The note's ink on the card it sits on, in both themes — WCAG AA for its
 *  12px text is 4.5:1. Read from the stylesheet, so a token change is seen. */
describe('the stub note\'s contrast', () => {
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it('meets AA on the trend card in light and dark', () => {
    const css = readFileSync(join(process.cwd(), 'styles/globals.css'), 'utf8');
    const tokens = (name: string): string[] => [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1]!);
    const ink = tokens('--ff-text-secondary');
    const card = tokens('--ff-bg-secondary');
    expect(ink).toHaveLength(2);
    expect(card).toHaveLength(2);
    for (let theme = 0; theme < 2; theme += 1) expect(ratio(ink[theme]!, card[theme]!)).toBeGreaterThanOrEqual(4.5);
  });
});
