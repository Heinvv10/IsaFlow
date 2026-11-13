/**
 * The Compare tab (budgets P6 spec §8, §13.22): the version on screen plus up to two more of the same year;
 * their closing cash overlaid on the runway chart and a KPI table whose Δ (version − first) takes its ink from
 * `varianceColor` alone, Δ = 0 neutral, Δ% "—" when the first is 0.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatStatementFigure } from '@/lib/format/money';
import { ChartFrame, useChartPalette } from '@/components/accounting/charts/ChartFrame';
import type { BudgetVersion } from '@/components/accounting/budgets/workspace/types';
import type { CompareView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { fetchCompare } from './threeWayClient';
import { deltaColour, deltaPctText, kpiRows } from './compareModel';
import { buildRunwayOption, MAX_RUNWAY_SERIES } from './runwayOption';

const R = (cents: number): string => formatStatementFigure(cents / 100, { symbol: true });
const signed = (cents: number): string => (cents > 0 ? `+${R(cents)}` : R(cents));

export interface CompareTabProps {
  versions: readonly BudgetVersion[];
  currentId: string;
}

export function CompareTab({ versions, currentId }: CompareTabProps) {
  const palette = useChartPalette();
  const [picked, setPicked] = useState<string[]>([]);
  const [data, setData] = useState<CompareView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => { setPicked([]); setData(null); setError(null); }, [currentId]);

  useEffect(() => {
    const mine = ++seq.current;
    if (picked.length === 0) { setData(null); setError(null); return; }
    setLoading(true);
    void fetchCompare([currentId, ...picked]).then((r) => {
      if (mine !== seq.current) return;
      setLoading(false);
      if (r.ok) { setData(r.data); setError(null); } else { setData(null); setError(r.message); }
    });
  }, [currentId, picked]);

  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));
  const full = picked.length + 1 >= MAX_RUNWAY_SERIES;
  const chart = useCallback(() => (data ? buildRunwayOption({
    months: data.months, series: data.versions.map((v) => ({ name: v.name, cents: v.cashSeries })), minimumCashCents: 0,
  }, palette) : null), [data, palette]);

  return (
    <div className="space-y-4" data-testid="compare-tab">
      <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-[var(--ff-text-primary)]">
        <legend className="mb-1 text-xs text-[var(--ff-text-secondary)]">Compare with up to {MAX_RUNWAY_SERIES - 1} other versions of this year</legend>
        {versions.map((v) => {
          const current = v.id === currentId;
          const on = current || picked.includes(v.id);
          return (
            <label key={v.id} className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={on} disabled={current || (!on && full) || loading} onChange={(e) => toggle(v.id, e.target.checked)} />
              {v.name}
            </label>
          );
        })}
      </fieldset>
      {error && <p role="alert" className="text-sm text-error-700 dark:text-error-400">{error}</p>}
      {picked.length === 0 && <p className="text-sm text-[var(--ff-text-secondary)]">Pick a version to compare.</p>}
      {data && (
        <>
          <ChartFrame title="Closing cash by version" unit="R, month end" height={260}>{chart}</ChartFrame>
          <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
            <table className="w-full min-w-[36rem] text-sm" data-testid="compare-kpis">
              <thead>
                <tr className="border-b border-[var(--ff-border-secondary)] text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)]">
                  <th className="py-2 pl-3 text-left font-medium">FY {data.fiscalYear}</th>
                  {data.versions.map((v, i) => (
                    <th key={v.versionId} colSpan={i === 0 ? 1 : 3} className="py-2 pr-3 text-right font-medium">{v.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {kpiRows(data).map((row) => (
                  <tr key={row.kpi} className="border-b border-[var(--ff-border-light)] last:border-0">
                    <th scope="row" className="py-2 pl-3 text-left font-normal text-[var(--ff-text-primary)]">{row.label}</th>
                    {row.cells.map((c) => (
                      <CellGroup key={c.versionId} kpiName={row.kpi} cell={c} colour={deltaColour(c.kpi, palette)} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function CellGroup({ kpiName, cell, colour }: { kpiName: string; cell: ReturnType<typeof kpiRows>[number]['cells'][number]; colour: string | undefined }) {
  const num = 'py-2 pr-3 text-right tabular-nums';
  return (
    <>
      <td className={`${num} text-[var(--ff-text-primary)]`}>{R(cell.kpi.value)}</td>
      {cell.showDelta && (
        <>
          <td className={num} data-testid={`delta-${kpiName}-${cell.versionId}`} style={colour ? { color: colour } : undefined}>
            {cell.kpi.delta === 0 ? R(0) : signed(cell.kpi.delta)}
          </td>
          <td className={`${num} text-[var(--ff-text-secondary)]`} data-testid={`deltapct-${kpiName}-${cell.versionId}`}>{deltaPctText(cell.kpi)}</td>
        </>
      )}
    </>
  );
}
