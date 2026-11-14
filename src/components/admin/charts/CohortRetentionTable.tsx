/**
 * Cohort Retention Table — styled HTML table with green→red heatmap.
 * Rows = signup cohort months. Columns = M0/M1/M2/M3 retention %.
 */

import type { CohortRetentionRow } from '@/modules/admin/types/admin.types';
import { formatDisplayMonthYear } from '@/utils/dateFormat';
import { formatRate } from '@/components/admin/formatMetric';

interface Props {
  data: CohortRetentionRow[];
}

function fmtMonth(dateStr: string) {
  const d = new Date(dateStr);
  return formatDisplayMonthYear(d);
}

/** Map a 0–100 % value to a Tailwind bg+text class (green→yellow→red). */
function heatmapClass(pct: number): string {
  if (pct >= 80) return 'bg-emerald-500/20 text-emerald-400';
  if (pct >= 60) return 'bg-green-500/15 text-green-400';
  if (pct >= 40) return 'bg-yellow-500/15 text-yellow-400';
  if (pct >= 20) return 'bg-orange-500/15 text-orange-400';
  if (pct > 0)   return 'bg-red-500/15 text-red-400';
  return 'text-gray-500';
}

/** null = that month has not ended yet: a dash, distinct from a real 0%. */
function PctCell({ value }: { value: number | null }) {
  return (
    <td className={`px-4 py-2.5 text-center text-xs font-semibold rounded ${value === null ? 'text-ink-muted' : heatmapClass(value)}`}>
      {formatRate(value)}
    </td>
  );
}

export function CohortRetentionTable({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-600 dark:text-gray-400 text-sm">
        No cohort data available yet
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
            <th className="px-4 py-3 font-medium">Cohort</th>
            <th className="px-4 py-3 font-medium text-center">Size</th>
            <th className="px-4 py-3 font-medium text-center">M0</th>
            <th className="px-4 py-3 font-medium text-center">M1</th>
            <th className="px-4 py-3 font-medium text-center">M2</th>
            <th className="px-4 py-3 font-medium text-center">M3</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr
              key={i}
              className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/30"
            >
              <td className="px-4 py-2.5 font-medium text-gray-800 dark:text-gray-200 text-xs">
                {fmtMonth(row.cohort_month)}
              </td>
              <td className="px-4 py-2.5 text-center text-xs text-gray-500 dark:text-gray-400">
                {row.cohort_size}
              </td>
              <PctCell value={row.m0_pct} />
              <PctCell value={row.m1_pct} />
              <PctCell value={row.m2_pct} />
              <PctCell value={row.m3_pct} />
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-xs text-gray-600 dark:text-gray-400 border-t border-gray-100 dark:border-gray-800">
        Share of each signup cohort with a live subscription at the end of the signup month (M0) and of each month after. A dash: that month has not ended.
      </p>
    </div>
  );
}
