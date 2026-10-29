/**
 * The Budget vs Actual visuals, wired (browser review r1 L1, L5): each chart is
 * an image with a text alternative (role="img", aria-label = the figures, from
 * trackingChartSummaries), the statement table is one link away, and the
 * heatmap is told which month is in progress (labelled "*", not judged). The
 * real ChartFrame and option builders run; only the ECharts canvas is replaced.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BudgetTrackingVisuals } from '@/components/accounting/budgets/tracking/BudgetTrackingVisuals';
import { bridgeSummary, bulletSummary, heatmapSummary } from '@/components/accounting/budgets/tracking/trackingChartSummaries';
import { budgetBridgeSteps } from '@/modules/accounting/services/budgets/tracking/budgetBridgeSteps';
import { toBulletLines } from '@/modules/accounting/services/budgets/tracking/trackingByMember';
import { trackingReport } from '../helpers/budgetTrackingReportFixture';

vi.mock('@/components/charts/EChartClient', () => ({
  EChartClient: ({ option }: { option: { xAxis?: { data?: string[] } } }) => <div data-testid="echart">{(option.xAxis?.data ?? []).join('|')}</div>,
}));

afterEach(cleanup);

const REPORT = trackingReport(
  [{ code: '4000', name: 'Sales', type: 'revenue', actual: 1200, budget: 1000 }, { code: '6000', name: 'Rent', type: 'expense', actual: 800, budget: 500 }],
  { members: [{ memberId: 'm1', code: 'FNO-A', name: 'North', actual: 400, budget: 500, variance: -100, favourable: false }] },
);

describe('BudgetTrackingVisuals', () => {
  it('every chart is an image whose label carries its figures', () => {
    render(<BudgetTrackingVisuals report={REPORT} filtered={false} groupBy="cc1" onGroupBy={vi.fn()} />);
    const images = screen.getAllByRole('img').map((e) => e.getAttribute('aria-label'));
    expect(images).toEqual([
      bridgeSummary(budgetBridgeSteps(REPORT)),
      bulletSummary(toBulletLines(REPORT.members!)),
      heatmapSummary(REPORT.lines, REPORT.window.months, REPORT.projection.cutoff.slice(0, 7)),
    ]);
  });

  it('the figures behind the charts are one link away, in the statement table', () => {
    render(<BudgetTrackingVisuals report={REPORT} filtered={false} groupBy="cc1" onGroupBy={vi.fn()} />);
    expect(screen.getByRole('link', { name: /figures behind these charts/i }).getAttribute('href')).toBe('#bva-statement');
  });

  it('the heatmap marks every month after the projection cutoff (here the month in progress) as not yet judged', () => {
    render(<BudgetTrackingVisuals report={REPORT} filtered={false} groupBy="cc1" onGroupBy={vi.fn()} />);
    expect(screen.getAllByTestId('echart').map((e) => e.textContent)).toContain('Oct 26 *');
  });

  it('with no budget the bridge says so, never "nothing posted" (Demo has actuals and no budget)', () => {
    const none = trackingReport([{ code: '4000', name: 'Sales', type: 'revenue', actual: 1200 }], { version: null });
    render(<BudgetTrackingVisuals report={none} filtered={false} groupBy="cc1" onGroupBy={vi.fn()} />);
    expect(screen.getByTestId('bva-bridge').textContent).toContain('No budget for net profit in this window, so there is no bridge.');
    expect(screen.getByTestId('bva-bridge').textContent).not.toContain('Nothing posted');
  });
});
