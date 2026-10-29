import { useCallback, useState } from 'react';
import type { TrackingLine } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { ChartFrame } from './ChartFrame';
import type { ChartPalette } from './chartTypes';
import { buildVarianceHeatmapOption, HEATMAP_DEFAULT_LIMIT } from './varianceHeatmapOption';

/** Account x month variance (actual − budget); hatched = no budget that month; "*" = in progress, not judged. */
export function VarianceHeatmap({ lines, months, inProgressMonth = null, summary }: {
  lines: TrackingLine[]; months: string[]; inProgressMonth?: string | null; summary?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const drawn = showAll ? lines.length : Math.min(lines.length, HEATMAP_DEFAULT_LIMIT);
  const build = useCallback(
    (p: ChartPalette) => buildVarianceHeatmapOption(lines, months, p, { showAll, inProgressMonth }),
    [lines, months, showAll, inProgressMonth],
  );
  return (
    <div>
      <ChartFrame
        title="Variance by month"
        unit={`Rand, actual − budget. Colour = favourable or not; hatched = no budget that month${
          inProgressMonth && months.includes(inProgressMonth) ? '; * = in progress, not judged' : ''}.`}
        height={Math.max(160, drawn * 28 + 72)}
        unavailable="No account carries actuals or a budget in this window."
        summary={summary}
      >
        {build}
      </ChartFrame>
      {lines.length > HEATMAP_DEFAULT_LIMIT && (
        <button
          type="button"
          className="mt-2 text-xs font-medium text-[var(--ff-brand-eyebrow)] hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? `Show the top ${HEATMAP_DEFAULT_LIMIT}` : `Show all ${lines.length} accounts`}
        </button>
      )}
    </div>
  );
}
