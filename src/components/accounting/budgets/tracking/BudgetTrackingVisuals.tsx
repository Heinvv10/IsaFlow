/**
 * Budget vs Actual visuals (budgets P3 spec §2.7): the profit bridge from
 * budget to actual net profit (`budgetBridgeSteps` → `ProfitWaterfall`), the
 * account × month variance heatmap, and one bullet per cost centre / business
 * unit (`trackingByMember.toBulletLines` → `BudgetBulletRow`). Thin: the steps,
 * cells and bullet lines are pure builders over the engine's report.
 *
 * The bullets need `group_by`, which the route refuses beside a filter, so
 * under a filter the bullet panel says so instead of drawing.
 */
import { useMemo } from 'react';
import { ProfitWaterfall } from '@/components/accounting/charts/ProfitWaterfall';
import { VarianceHeatmap } from '@/components/accounting/charts/VarianceHeatmap';
import { BudgetBulletRow } from '@/components/accounting/charts/BudgetBulletRow';
import { budgetBridgeSteps } from '@/modules/accounting/services/budgets/tracking/budgetBridgeSteps';
import { toBulletLines } from '@/modules/accounting/services/budgets/tracking/trackingByMember';
import type { BudgetTrackingReport, TrackingGroupBy } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

const GROUP_LABEL: Record<TrackingGroupBy, string> = { cc1: 'Cost centre 1', cc2: 'Cost centre 2', bu: 'Business unit' };

export function BudgetTrackingVisuals({ report, filtered, groupBy, onGroupBy }: {
  report: BudgetTrackingReport; filtered: boolean; groupBy: TrackingGroupBy; onGroupBy: (g: TrackingGroupBy) => void;
}) {
  const steps = useMemo(() => budgetBridgeSteps(report), [report]);
  const bullets = useMemo(() => (report.members ? toBulletLines(report.members) : []), [report]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div data-testid="bva-bridge" className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-3">
        <ProfitWaterfall steps={steps} title="Budget to actual net profit" unit="Rand, effect on profit per band" />
      </div>
      <div data-testid="bva-bullets" className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-3">
        <div className="mb-2 flex items-center justify-end gap-2">
          <label htmlFor="bva-group-by" className="text-xs text-[var(--ff-text-tertiary)]">Bullets by</label>
          <select id="bva-group-by" data-testid="bva-group-by" value={groupBy} disabled={filtered}
            onChange={(e) => onGroupBy(e.target.value as TrackingGroupBy)} className="ff-input text-xs disabled:opacity-60">
            {(Object.keys(GROUP_LABEL) as TrackingGroupBy[]).map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
          </select>
        </div>
        {filtered
          ? <p className="py-8 text-center text-sm text-[var(--ff-text-secondary)]">Per-member bullets show on the unfiltered report.</p>
          : <BudgetBulletRow lines={bullets} limit={12} />}
      </div>
      <div data-testid="bva-heatmap" className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-3 lg:col-span-2">
        <VarianceHeatmap lines={report.lines} months={report.window.months} />
      </div>
    </div>
  );
}
