/**
 * Financial Analysis's ratio-trend chart, mounted alone in a real browser at
 * the widths the page gives it, over 3, 6 and 12 months ending in a stub.
 * Bundled by `bundlePrintPages.ts` for `ratioTrendTicks.test.ts`.
 */
import { createRoot } from 'react-dom/client';
import { RatioTrendChart, type RatioTrendChartPoint } from '@/components/accounting/charts/RatioTrendChart';

const MONTHS = ['Nov 2025', 'Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026',
  'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026'];
const series = (count: number): RatioTrendChartPoint[] => MONTHS.slice(-count).map((period, i, all) => ({
  period, value: 40 + ((i * 7) % 13), partial: i === all.length - 1,
}));

const WIDTHS = [260, 340, 420, 520, 640];
const cases = WIDTHS.flatMap((width) => [3, 6, 12].map((count) => ({ width, count })));

createRoot(document.getElementById('root')!).render(
  <>
    {cases.map(({ width, count }) => (
      <div key={`${width}-${count}`} data-case={`${width}px, ${count} months`} style={{ width, marginBottom: 16 }}>
        <RatioTrendChart values={series(count)} />
      </div>
    ))}
  </>,
);
