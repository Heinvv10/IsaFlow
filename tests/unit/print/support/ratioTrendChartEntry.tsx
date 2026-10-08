/**
 * Financial Analysis's ratio-trend chart, mounted alone in a real browser at
 * the widths the page gives it, over 3, 6 and 12 months ending in a stub.
 * Bundled by `bundlePrintPages.ts` for `ratioTrendTicks.test.ts`.
 */
import { createRoot } from 'react-dom/client';
import { RatioTrendChart, type RatioTrendChartPoint } from '@/components/accounting/charts/RatioTrendChart';

/** The months the route labels, as it labels them — en-ZA, so September is
 *  "Sept", the widest. `count` months ending with month `end` (0-based) of
 *  2026, the last a stub. */
const series = (count: number, end: number): RatioTrendChartPoint[] => Array.from({ length: count }, (_, i) => {
  const date = new Date(2026, end - (count - 1 - i), 1);
  return {
    period: date.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' }),
    value: 40 + ((i * 7) % 13),
    partial: i === count - 1,
  };
});

const WIDTHS = [260, 340, 420, 520, 579, 640];
// October (the case the browser check found) and September, whose label is
// the longest the route prints.
const cases = WIDTHS.flatMap((width) => [9, 8].flatMap((end) => [3, 6, 12].map((count) => ({ width, count, end }))));

createRoot(document.getElementById('root')!).render(
  <>
    {cases.map(({ width, count, end }) => (
      <div key={`${width}-${count}-${end}`} data-case={`${width}px, ${count} months to month ${end + 1}`} data-stub={series(count, end).at(-1)!.period}
        style={{ width, marginBottom: 16 }}>
        <RatioTrendChart values={series(count, end)} />
      </div>
    ))}
  </>,
);
