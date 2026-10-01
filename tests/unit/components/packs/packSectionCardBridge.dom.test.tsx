/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * THE ON-SCREEN CARD DRAWS THE PROFIT BRIDGE. It printed "Waterfall chart data
 * available — render with WaterfallChart component", a developer's TODO, in
 * place of a chart. The bridge is drawn by `ProfitWaterfall`, the component the
 * rest of the app uses, from the section the real service built.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/charts/EChartClient', () => ({
  EChartClient: ({ option }: { option: Record<string, unknown> }) => (
    <div data-testid="echart" data-option={JSON.stringify(option)} />
  ),
}));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { SectionCard } from '@/components/accounting/packs/PackSectionCard';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';

const INPUT: ReportPackInput = {
  companyName: 'Demo', period: '2026-03-01 to 2026-08-31',
  revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000, netProfit: 480_123,
  totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 2_200_000,
  currentAssets: 1_900_000, currentLiabilities: 950_000,
  cash: 2_046_825, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
};
const bridge = () => buildReportPack('management', INPUT, '2026-03-01', '2026-08-31').sections.find((s) => s.type === 'waterfall')!;

function open(section: { type: string; title: string; data: Record<string, unknown> }) {
  const view = render(<SectionCard section={section} />);
  fireEvent.click(screen.getByRole('button'));
  return view;
}

const injected: HTMLStyleElement[] = [];
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  for (const s of injected.splice(0)) s.remove();
});

describe('SectionCard waterfall', () => {
  it('draws the bridge from the real section and prints no placeholder', () => {
    open(bridge());
    const chart = screen.getByTestId('echart');
    const option = JSON.parse(chart.getAttribute('data-option')!);
    expect(JSON.stringify(option)).toContain('Revenue');
    expect(document.body.textContent).not.toContain('render with WaterfallChart');
    expect(screen.getByText('Profit bridge')).toBeTruthy();
  });

  it('draws one bar per step the service composed', () => {
    const steps = (bridge().data as { steps: unknown[] }).steps;
    open(bridge());
    const option = JSON.parse(screen.getByTestId('echart').getAttribute('data-option')!);
    expect(steps.length).toBeGreaterThan(2);
    expect(JSON.stringify(option).match(/Revenue/g)!.length).toBeGreaterThan(0);
  });

  it('shows a notice, not a crash, for a saved pack with no steps', () => {
    const { steps: _omitted, ...old } = bridge().data;
    open({ type: 'waterfall', title: 'Profit bridge', data: old });
    expect(screen.queryByTestId('echart')).toBeNull();
    expect(screen.getByText(/carries no profit bridge/)).toBeTruthy();
  });

  it('still throws on a malformed steps field', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => open({ type: 'waterfall', title: 'Profit bridge', data: { steps: 'x' } })).toThrow(/steps/);
    quiet.mockRestore();
  });

  it('repaints in the other theme: the light and dark palettes reach the chart', async () => {
    const style = document.createElement('style');
    style.textContent = ':root { --ff-text-tertiary: #111111; --ff-border-light: #dddddd; } .dark { --ff-text-tertiary: #eeeeee; --ff-border-light: #222222; }';
    document.head.appendChild(style);
    injected.push(style);
    open(bridge());
    const read = () => screen.getByTestId('echart').getAttribute('data-option')!;
    // The axis colours come from the page's theme variables (`--ff-text-tertiary`,
    // `--ff-border-light`); the series' ink sits in a callback JSON cannot show.
    await waitFor(() => expect(read()).toContain('#111111'));
    expect(read()).not.toContain('#eeeeee');
    await act(async () => {
      document.documentElement.classList.add('dark');
      await Promise.resolve();
    });
    await waitFor(() => expect(read()).toContain('#eeeeee'));
    expect(read()).not.toContain('#111111');
  });
});
