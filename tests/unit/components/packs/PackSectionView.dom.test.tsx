/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, renderHook, screen, cleanup } from '@testing-library/react';
import type { PackDocumentSection } from '@/modules/accounting/services/packs/packDocument';

// EChartClient is a next/dynamic(ssr:false) import of a canvas library; the
// wrapper's contract here is the container it renders, not ECharts itself.
vi.mock('@/components/charts/EChartClient', () => ({
  EChartClient: () => <div data-testid="echart" />,
}));

import { PackSectionView } from '@/components/accounting/packs/PackSectionView';
import { countCharts, usePrintMode, usePrintReady } from '@/components/accounting/packs/usePrintMode';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.className = '';
  window.localStorage.clear();
});

const statementSection: PackDocumentSection = {
  type: 'income_statement',
  title: 'Statement of Comprehensive Income',
  landscape: false,
  blocks: [
    { kind: 'statement', rows: [
      { id: 'sub:revenue', kind: 'subtotal', label: 'Turnover', depth: 0, actual: 4812345.67 },
      { id: 'grand:netProfit', kind: 'grand', label: 'Net Profit / (Loss)', depth: 0, actual: 1275632.74 },
    ] },
    { kind: 'kv', items: [{ label: 'Gross Margin', value: 54.5, format: 'pct' }] },
  ],
};

const chartSection: PackDocumentSection = {
  type: 'waterfall',
  title: 'Profit Bridge',
  landscape: true,
  blocks: [{ kind: 'waterfall', steps: [
    { label: 'Revenue', start: 0, end: 1000, value: 1000, isSubtotal: false, color: 'green' },
  ] }],
};

describe('PackSectionView', () => {
  it('prints the section title', () => {
    render(<PackSectionView section={statementSection} />);
    expect(screen.getByText('Statement of Comprehensive Income')).toBeTruthy();
  });

  it('renders statement figures through the grid, formatted with cents', () => {
    render(<PackSectionView section={statementSection} />);
    expect(screen.getByText('4 812 345.67')).toBeTruthy();
    expect(screen.getByText('1 275 632.74')).toBeTruthy();
  });

  it('renders a percentage KV item as a percentage, not as money', () => {
    render(<PackSectionView section={statementSection} />);
    expect(screen.getByText('+54.5%')).toBeTruthy();
  });

  it('renders a day count in days, not as a bare ratio', () => {
    render(<PackSectionView section={{ ...statementSection, blocks: [
      { kind: 'kv', items: [{ label: 'Debtor Days', value: 45.4, format: 'days' }] },
    ] }} />);
    expect(screen.getByText('45 days')).toBeTruthy();
  });

  it('prints the unavailable text INSTEAD of the figure, as KpiTile does', () => {
    render(<PackSectionView section={{ ...statementSection, blocks: [
      { kind: 'kv', items: [{ label: 'Return on Equity', value: null, format: 'pct', unavailable: 'Negative equity' }] },
    ] }} />);
    expect(screen.getByText('Negative equity')).toBeTruthy();
    expect(screen.queryByText('+0.0%')).toBeNull();
  });

  it('never prints a null figure as zero', () => {
    render(<PackSectionView section={{ ...statementSection, blocks: [
      { kind: 'kv', items: [{ label: 'Working Capital', value: null, format: 'money' }] },
      { kind: 'scorecard', items: [
        { ratioKey: 'returnOnEquity', name: 'ROE', value: null, target: 15, status: 'not_meaningful', reason: 'Negative equity', percentOfTarget: 0 },
      ] },
    ] }} />);
    expect(screen.queryByText('0.00')).toBeNull();
    expect(screen.getByText('Negative equity')).toBeTruthy();
  });

  it('marks a chart section landscape and tags the chart container', () => {
    const { container } = render(<PackSectionView section={chartSection} />);
    expect(container.querySelector('[data-print-landscape]')).toBeTruthy();
    expect(container.querySelector('[data-pack-chart]')).toBeTruthy();
  });

  it('leaves a portrait section untagged', () => {
    const { container } = render(<PackSectionView section={statementSection} />);
    expect(container.querySelector('[data-print-landscape]')).toBeNull();
  });

  it('breaks the page before every section', () => {
    const { container } = render(<PackSectionView section={statementSection} />);
    expect(container.querySelector('[data-print-break]')).toBeTruthy();
  });
});

describe('countCharts', () => {
  it('counts the blocks that draw a chart and nothing else', () => {
    expect(countCharts([statementSection, chartSection])).toBe(1);
    expect(countCharts([statementSection])).toBe(0);
  });
});

describe('usePrintMode', () => {
  it('takes the page to light BEFORE ThemeProvider mounts, and stores the preference', () => {
    document.documentElement.classList.add('dark');
    renderHook(() => usePrintMode(true));
    expect(document.documentElement.classList.contains('print-mode')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem('accounting-theme')).toBe('light');
  });

  it('does nothing when print mode is off', () => {
    document.documentElement.classList.add('dark');
    renderHook(() => usePrintMode(false));
    expect(document.documentElement.classList.contains('print-mode')).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('usePrintReady', () => {
  it('stays false while the data is still loading', () => {
    const { result } = renderHook(() => usePrintReady(false, 0));
    expect(result.current).toBe(false);
  });

  it('is ready immediately when the document draws no charts', () => {
    const { result } = renderHook(() => usePrintReady(true, 1 - 1));
    expect(result.current).toBe(true);
  });

  it('refuses to be ready until every chart has actually drawn an svg', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    host.setAttribute('data-pack-chart', '');
    document.body.appendChild(host);

    const { result } = renderHook(() => usePrintReady(true, 2));
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current).toBe(false);

    host.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current).toBe(false);

    const second = document.createElement('div');
    second.setAttribute('data-pack-chart', '');
    second.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    document.body.appendChild(second);
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current).toBe(true);

    host.remove();
    second.remove();
  });
});
