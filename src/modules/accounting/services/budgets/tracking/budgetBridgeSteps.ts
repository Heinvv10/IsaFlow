/**
 * The Budget vs Actual profit bridge (budgets P3 spec §2.7): budget net profit,
 * one step per income-statement band, actual net profit. Pure; the existing
 * `ProfitWaterfall` draws it.
 *
 * A band's step is its EFFECT ON PROFIT: income bands +Δ, expense bands −Δ,
 * where Δ = actual − budget (an absent band budget counts 0, as it does in the
 * engine's net profit). The bar's label carries the ledger-signed Δ
 * (`labelValue`, per the `WaterfallStep` header) so an overspent cost reads as
 * the positive figure the table prints beside it. The bar colour is
 * `waterfallOption.barColor`'s, i.e. `varianceColor` of the movement; the
 * `color` hint here is ignored by the chart.
 *
 * Integer cents throughout, so the steps foot exactly:
 * budget NP + Σ effects = actual NP. No budget at all (net profit budget
 * absent) is no bridge, not a bridge from zero.
 */
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { fromCents, toCents } from './trackingLines';
import type { BudgetTrackingReport, TrackingBandKey } from './trackingTypes';

const STEPS: Array<{ key: TrackingBandKey; label: string; sign: 1 | -1 }> = [
  { key: 'turnover', label: 'Turnover', sign: 1 },
  { key: 'cost_of_sales', label: 'Cost of Sales', sign: -1 },
  { key: 'other_income', label: 'Other Income', sign: 1 },
  { key: 'operating_expenses', label: 'Operating Expenses', sign: -1 },
  { key: 'other_expenses', label: 'Other Expenses', sign: -1 },
];

export function budgetBridgeSteps(report: Pick<BudgetTrackingReport, 'bands'>): WaterfallStep[] {
  const net = report.bands.find((b) => b.key === 'net_profit');
  if (!net || net.budget === null) return [];
  const budgetNp = toCents(net.budget);
  const steps: WaterfallStep[] = [
    { label: 'Budget net profit', start: 0, end: fromCents(budgetNp), value: fromCents(budgetNp), isSubtotal: true, color: 'blue' },
  ];
  let running = budgetNp;
  for (const s of STEPS) {
    const band = report.bands.find((b) => b.key === s.key);
    const delta = band ? toCents(band.actual) - toCents(band.budget ?? 0) : 0;
    const effect = s.sign * delta;
    const step: WaterfallStep = {
      label: s.label, start: fromCents(running), end: fromCents(running + effect), value: fromCents(effect),
      isSubtotal: false, color: effect >= 0 ? 'green' : 'red',
    };
    if (s.sign === -1) step.labelValue = fromCents(delta);
    steps.push(step);
    running += effect;
  }
  steps.push({ label: 'Actual net profit', start: 0, end: fromCents(toCents(net.actual)), value: fromCents(toCents(net.actual)), isSubtotal: true, color: 'blue' });
  return steps;
}
