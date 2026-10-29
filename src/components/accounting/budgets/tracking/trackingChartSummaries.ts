/**
 * Text alternatives for the Budget vs Actual charts (browser review r1 L5). A
 * chart is an image to a screen reader (`ChartFrame summary` → role="img"), so
 * its aria-label carries the figures the chart shows, read off the same data
 * the chart draws: the bridge's steps, the bullets' ranked members, the
 * heatmap's largest judged variance either way. The months not yet judged (in
 * progress or still to come) are named and left out of the extremes, as they
 * are left out of the heatmap's colour scale.
 * Pure; every figure through `formatStatementFigure`, as on the statement.
 */
import { formatStatementFigure } from '@/lib/format/money';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import type { TrackingLine } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

const fig = (n: number) => formatStatementFigure(n);

export function bridgeSummary(steps: readonly WaterfallStep[]): string {
  if (steps.length === 0) return 'Profit bridge: no budget for net profit in this window.';
  return `Profit bridge: ${steps.map((s) => `${s.label} ${fig(s.value)}`).join('; ')}.`;
}

/** The members in the chart's own order: budgeted only, largest |variance| first. */
export function bulletSummary(lines: readonly BudgetVsActualLine[], limit = 12): string {
  const ranked = lines.filter((l) => l.budgeted).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance)).slice(0, limit);
  if (ranked.length === 0) return 'Budget variance by member: no member carries a budget in this window.';
  return `Budget variance by member: ${ranked.map((l) => `${l.account_name}: actual ${fig(l.actual_amount)}, budget ${fig(l.budget_amount)}, `
    + `variance ${fig(l.movement)}${l.favourable === null ? '' : l.favourable ? ', favourable' : ', unfavourable'}`).join('; ')}.`;
}

export function heatmapSummary(lines: readonly TrackingLine[], months: readonly string[], judgedThrough: string | null): string {
  const span = months.length === 0 ? '' : ` (${monthLabel(months[0]!)} to ${monthLabel(months[months.length - 1]!)})`;
  const judged = (m: string) => judgedThrough === null || m <= judgedThrough;
  const later = months.filter((m) => !judged(m));
  const progress = later.length === 0 ? ''
    : `; ${monthLabel(later[0]!)}${later.length > 1 ? ` to ${monthLabel(later[later.length - 1]!)}` : ''} not yet judged`;
  const cells = lines.flatMap((l) => l.monthly
    .filter((m) => m.variance !== null && m.favourable !== null && judged(m.month) && months.includes(m.month))
    .map((m) => ({ name: `${l.accountCode} ${l.accountName}`, month: m.month, variance: m.variance!, favourable: m.favourable! })));
  const largest = (favourable: boolean) => cells.filter((c) => c.favourable === favourable)
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))[0];
  const say = (word: string, c: ReturnType<typeof largest>) => (c ? ` Largest ${word}: ${c.name}, ${monthLabel(c.month)}, ${fig(c.variance)}.` : '');
  return `Variance by month for ${lines.length} account${lines.length === 1 ? '' : 's'} over ${months.length} month${months.length === 1 ? '' : 's'}${span}${progress}.`
    + say('unfavourable', largest(false)) + say('favourable', largest(true));
}
