/**
 * The Compare tab's KPI table (budgets P6 spec §13.22). Δ = version − first and `favourable` are the SERVER's
 * (`compare.ts`); this only lays them out and picks the ink, which comes from `ibcs.varianceColor` alone: a
 * favourable Δ in the fav ink, an unfavourable one in the unfav ink, Δ = 0 (`favourable` null) neutral. The ink
 * follows `favourable`, never the sign: lower receivables is good news. Δ% is "—" when the first version is 0.
 */
import { varianceColor } from '@/components/accounting/charts/ibcs';
import type { ChartPalette } from '@/components/accounting/charts/chartTypes';
import { formatPct } from '@/lib/format/money';
import type { CompareView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import type { KpiDelta, KpiName } from '@/modules/accounting/services/budgets/threeWay/compare';

export const KPI_LABELS: Record<KpiName, string> = {
  closingCash: 'Closing cash (year end)',
  minCash: 'Lowest month-end cash',
  netProfit: 'Net profit (year)',
  closingReceivables: 'Closing receivables',
  closingPayables: 'Closing payables',
  netDebt: 'Net debt (loans − cash)',
};
const ORDER: readonly KpiName[] = ['closingCash', 'minCash', 'netProfit', 'closingReceivables', 'closingPayables', 'netDebt'];

export function deltaColour(k: KpiDelta, palette: ChartPalette): string | undefined {
  return varianceColor(k.favourable ?? undefined, palette);
}

export function deltaPctText(k: KpiDelta): string {
  return k.deltaPct === null ? '—' : formatPct(k.deltaPct);
}

export interface KpiCell { versionId: string; kpi: KpiDelta; showDelta: boolean }
export interface KpiRow { kpi: KpiName; label: string; cells: KpiCell[] }

/** One row per KPI; the first version is the base and shows no Δ. */
export function kpiRows(view: CompareView): KpiRow[] {
  return ORDER.map((name) => ({
    kpi: name,
    label: KPI_LABELS[name],
    cells: view.versions.map((v, i) => ({ versionId: v.versionId, kpi: v.kpis[name], showDelta: i > 0 })),
  }));
}
