/**
 * Page 8's closing-cash line and the height ladder it steps. Moved out of
 * `packTrendCharts.ts` unchanged to keep that file under the 300-line cap;
 * `packTrendCharts.ts` re-exports both builders.
 */

import { PAGE_WIDTH_MM } from './packTextMetrics';
import { svgBoxFor } from './packChartBox';
import { formatMoney, inProse, type MoneyScale } from '@/lib/format/money';
import { CHART_HEIGHT_MM, renderChartSvg, type TrustedChartSvg } from '@/lib/charts/ssrSvg';
import { DEFAULT_CHART_PALETTE } from '@/modules/accounting/services/packs/packChartOptions';
import { endLabelCandidates, endLabelFits, type EndLabelPlacement } from './packEndLabelPlacement';
import { sharedDomain, smallMultipleOption } from '@/modules/accounting/services/packs/packLineChartOptions';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { monthLabel, partialMonthClause } from './packPartialMonth';
import type { PackChartSpec } from './packPageModel';

/**
 * Page 8's closing-cash line, ON SPEC §5.6's HEIGHT GRID and no longer on a
 * height of its own.
 *
 * It was a fixed 36mm — chosen when this chart shared the busiest page in
 * the pack with a cash bridge, four footnotes and two disclosures, and that
 * page was printing on two sheets. The cost of that fix outlived the problem
 * it fixed: on a company with no bridge to draw, page 8 ends at two thirds
 * of the sheet with its only picture of cash in a band under half the plot
 * depth of the charts on the two sheets before it, on a measure the other
 * two do not use. Three charts, three geometries, in a document whose
 * furniture is otherwise identical page to page.
 *
 * So it steps the same 110 / 72 / 48 rungs the profit bridge steps, and the
 * page it is on decides which — by composing and measuring, exactly as page
 * 6 does (see `boardPackPages`). A page with a bridge and two disclosures
 * still lands on the bottom rung; a page without them gets a chart the size
 * of the paper it has.
 *
 * AND IT IS ON THE TABLE MEASURE, which is the part that got missed.
 * `packPageCharts` took `PAGE_WIDTH_MM.portrait` for pages 6 and 7 and this
 * ladder kept its own literal 170, so the cash line stayed 4mm narrower than
 * the table above it while the other two moved — three chart pages, three
 * right edges, which is the finding this was meant to close.
 */
const CASH_TREND_RUNGS = [
  { widthMm: PAGE_WIDTH_MM.portrait, heightMm: CHART_HEIGHT_MM.full },
  { widthMm: PAGE_WIDTH_MM.portrait, heightMm: CHART_HEIGHT_MM.half },
  { widthMm: PAGE_WIDTH_MM.portrait, heightMm: CHART_HEIGHT_MM.inline },
  // AND ONE BELOW THE GRID, FOR THE PAGE THAT CARRIES A BRIDGE AS WELL.
  // 36mm is the height this line held before it had a grid to step, kept as
  // the bottom rung rather than deleted: where page 8 also carries a cash
  // bridge, two charts, a five-row table with four footnotes and two
  // disclosures do not fit at 48, and `fitPageToBox` pays the difference by
  // dropping the sentence saying part of the movement is unexplained —
  // measured, in `boardPackPages.test.ts`. A rung off the grid on the
  // crowded page is a smaller cost than a chart bought with that sentence.
  { widthMm: PAGE_WIDTH_MM.portrait, heightMm: 36 },
] as const;

/**
 * Page 8 — the closing-cash line spec §4.A page 8 asks for, drawn from the
 * trend's month-end cash positions. Distinct from `buildCashWaterfallChart`
 * above, which bridges opening to closing cash for the CURRENT period only;
 * this is the multi-period LEVEL, which is a different question ("where has
 * cash been standing") from the bridge's ("what moved it this period").
 *
 * Null when there is no trend series to plot — the same "say why, don't
 * invent" rule the rest of this file follows rather than opening at zero.
 */
function drawnWithEndLabel(
  points: Array<{ label: string; value: number }>,
  domain: { min: number; max: number },
  scale: MoneyScale,
  plot: { widthMm: number; heightMm: number },
): TrustedChartSvg {
  const falls = points.length > 1 && points[points.length - 2]!.value > points[points.length - 1]!.value;
  const draw = (at: EndLabelPlacement) => renderChartSvg(
    smallMultipleOption(points, domain, (n) => formatMoney(n, { scale }), undefined, { unit: scale, endLabelAt: at }),
    plot,
  );
  const candidates = endLabelCandidates(falls);
  for (const at of candidates) {
    const svg = draw(at);
    if (endLabelFits(String(svg), DEFAULT_CHART_PALETTE)) return svg;
  }
  // Nowhere clear: the first preference, which keeps the label on the plot
  // side the line did not arrive from.
  return draw(candidates[0]!);
}

export function buildCashTrendChart(
  trend: PackTrendPoint[],
  scale: MoneyScale,
  box: { widthMm: number; heightMm: number } = CASH_TREND_RUNGS[0],
): PackChartSpec | null {
  if (trend.length === 0) return null;
  const points = trend.map((p) => ({ label: monthLabel(p), value: p.cash }));
  const domain = sharedDomain([points.map((p) => p.value)]);
  const first = points[0]!.value;
  const last = points[points.length - 1]!.value;
  const direction = last >= first ? 'rose' : 'fell';
  const money = (n: number) => inProse(formatMoney(n, { scale }));
  // CASH IS A POSITION, NOT A MOVEMENT, so the stub costs it less than it
  // costs a flow panel — a balance at 7 September is a real balance at
  // 7 September. It is still measured to a different date from the eleven
  // month-ends before it, and this sentence names both endpoints by month, so
  // it says which one.
  const closing = trend[trend.length - 1]!;
  // NAMED PERIODS, not just a count. This panel shares a sheet with the cash
  // table, whose Opening cash is the START OF THE REPORTING PERIOD, while this
  // series opens wherever the twelve-month window does — (125) at 1 January
  // against (115) at the previous October, two different numbers for the word
  // "opening", with nothing on the sheet saying they were different series.
  // The endpoints carry their own months now, so the reader can see that.
  // HOISTED for `svgBoxFor`: this title is the longest in the pack — it names
  // two months, two figures, a period count and, on a stub, the part-month
  // clause — so it is the chart whose SVG was letterboxed hardest.
  const cashTitle =
    `Closing cash ${direction} from ${money(first)} at ${points[0]!.label} ` +
    `to ${money(last)} at ${points[points.length - 1]!.label}, over ${points.length} periods.` +
    (closing.partial ? ` ${partialMonthClause(closing)}` : '');
  const cashPlot = svgBoxFor(box, cashTitle);
  return {
    id: 'cash-trend',
    title: cashTitle,
    kind: 'line',
    // LABELLED, unlike a page-10 panel. This one is on the page's own text
    // measure and is the only picture of cash a director gets; bare, it was
    // six gridlines carrying one number. The end label is placed by drawing
    // and reading back — see `packEndLabelPlacement`.
    svg: drawnWithEndLabel(points, domain, scale, cashPlot),
    heightMm: box.heightMm,
    plotMm: cashPlot.heightMm,
    // What that sentence ASSERTS, as a number, so the gate can hold it
    // against the cash table's own `Closing cash` row on the same page. The
    // rendered pack stated `(532)` in the table and `(752)` here, and nothing
    // in the pipeline could see it — see `checkChartClaims`.
    claims: [{ label: 'Closing cash', value: last }],
  };
}

/** The next rung down for page 8's cash line, or null at the bottom — the
 *  same shape `shorterProfitBridge` gives page 6, so both pages choose a
 *  chart height by measuring the sheet rather than by predicting it. */
export function shorterCashTrendChart(
  trend: PackTrendPoint[],
  scale: MoneyScale,
  current: PackChartSpec,
): PackChartSpec | null {
  const rung = CASH_TREND_RUNGS.findIndex((b) => b.heightMm === current.heightMm);
  const next = rung === -1 ? undefined : CASH_TREND_RUNGS[rung + 1];
  return next === undefined ? null : buildCashTrendChart(trend, scale, next);
}
