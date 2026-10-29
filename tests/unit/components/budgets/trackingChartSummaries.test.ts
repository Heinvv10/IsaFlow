/**
 * The Budget vs Actual charts' text alternatives (browser review r1 L5): each chart is an image to a
 * screen reader (role="img"), so its aria-label must carry the figures it shows, from the same data:
 * the bridge's steps, the bullets' members, the heatmap's extremes (the month in progress left out,
 * as it is out of the colour scale).
 */
import { describe, expect, it } from 'vitest';
import { formatStatementFigure } from '@/lib/format/money';
import { bridgeSummary, bulletSummary, heatmapSummary } from '@/components/accounting/budgets/tracking/trackingChartSummaries';
import { budgetBridgeSteps } from '@/modules/accounting/services/budgets/tracking/budgetBridgeSteps';
import { toBulletLines } from '@/modules/accounting/services/budgets/tracking/trackingByMember';
import { trackingReport } from '../../helpers/budgetTrackingReportFixture';

const f = (n: number) => formatStatementFigure(n);
const REPORT = trackingReport([
  { code: '4000', name: 'Sales', type: 'revenue', actual: 1200, budget: 1000 },
  { code: '6000', name: 'Rent', type: 'expense', actual: 800, budget: 500 },
]);

describe('chart summaries', () => {
  it('the bridge reads budget net profit, each band effect and actual net profit', () => {
    const s = bridgeSummary(budgetBridgeSteps(REPORT));
    expect(s).toBe(`Profit bridge: Budget net profit ${f(500)}; Turnover ${f(200)}; Cost of Sales ${f(0)}; Other Income ${f(0)}; `
      + `Operating Expenses ${f(-300)}; Other Expenses ${f(0)}; Actual net profit ${f(400)}.`);
    expect(bridgeSummary([])).toBe('Profit bridge: no budget for net profit in this window.');
  });

  it('the bullets read each member: actual, budget, variance and whether it is good news', () => {
    const lines = toBulletLines([
      { memberId: 'a', code: 'FNO-A', name: 'North', actual: 120, budget: 100, variance: 20, favourable: true },
      { memberId: null, code: '', name: 'Untagged / company level', actual: 40, budget: 90, variance: -50, favourable: false },
    ]);
    expect(bulletSummary(lines)).toBe(`Budget variance by member: Untagged / company level: actual ${f(40)}, budget ${f(90)}, `
      + `variance ${f(-50)}, unfavourable; FNO-A North: actual ${f(120)}, budget ${f(100)}, variance ${f(20)}, favourable.`);
    expect(bulletSummary([])).toBe('Budget variance by member: no member carries a budget in this window.');
  });

  it('the heatmap reads its size, the month in progress, and the largest variance either way', () => {
    const lines = REPORT.lines.map((l) => ({
      ...l,
      monthly: [
        { month: '2026-09', actual: 0, budget: 0, budgetAboveFilter: false, variance: l.accountCode === '4000' ? 30 : 70, favourable: l.accountCode === '4000' },
        { month: '2026-10', actual: 0, budget: 0, budgetAboveFilter: false, variance: 9999, favourable: false },
      ],
    }));
    expect(heatmapSummary(lines, ['2026-09', '2026-10'], '2026-10')).toBe(
      'Variance by month for 2 accounts over 2 months (Sep 2026 to Oct 2026); Oct 2026 is in progress and not judged. '
      + `Largest unfavourable: 6000 Rent, Sep 2026, ${f(70)}. Largest favourable: 4000 Sales, Sep 2026, ${f(30)}.`);
  });
});
