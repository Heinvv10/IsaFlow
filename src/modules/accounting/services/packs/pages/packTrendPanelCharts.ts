/**
 * One page-10 panel as a chart spec — a money panel, a ratio panel, and the
 * two reads they share (the point furthest from the first, the last month a
 * ratio plots). Moved out of `packTrendCharts.ts` unchanged to keep that file
 * under the 300-line cap; `buildTrendPanels` there composes them.
 */

import { formatStatementFigure, formatPctLevel, inProse, type MoneyScale } from '@/lib/format/money';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import { sharedDomain, smallMultipleOption } from '@/modules/accounting/services/packs/packLineChartOptions';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { movementSentence, type Domain } from './packTrendScale';
import { monthLabel } from './packPartialMonth';
import type { PackChartSpec } from './packPageModel';
import { PANEL, type MoneyPanel, type RatioPanel } from './packTrendPanelSet';
import { panelAxisLabels } from './packPanelZero';

export function moneyPanel(
  panel: MoneyPanel,
  trend: PackTrendPoint[],
  scale: MoneyScale,
  drawn: { domain: Domain; shared: boolean; ownSharePct: number },
  dominant: {
    label: string;
    value: number;
    sharePct: number;
    /** The range that is left when the point goes, AS PRINTED — the other
     *  half of the shrink claim, so a reader can take the subtraction
     *  themselves. See `ScaleDominator.residual`. */
    residualRange: string;
    creditMonth: string | null;
  } | null,
): PackChartSpec {
  // THE X-AXIS CARRIES THE MARK TOO — `monthLabel`. The panel labels its
  // first and last tick only, so the terminal tick IS the stub wherever there
  // is one, and it is the tick the reader reads the end label against.
  const points = trend.map((point) => ({ label: monthLabel(point), value: panel.pick(point) }));
  const first = points[0]!.value;
  const last = points[points.length - 1]!.value;
  const money = (n: number) => formatStatementFigure(n, { scale });
  const prose = (n: number) => inProse(money(n));
  // AND THE SENTENCE SAYS WHICH MONTH ITS LAST FIGURE IS, where that month is
  // a stub. "Revenue rose from nil to 30 over 12 periods" states a current
  // position measured over seven days of September; unmarked, that is the
  // sentence a director repeats back in the meeting.
  const terminal = trend[trend.length - 1];
  const clauses = [movementSentence(
    panel.name, prose(first), prose(last), points.length, last >= first,
    terminal !== undefined && terminal.partial ? monthLabel(terminal) : undefined,
    // THE EXCURSION, for the case where the endpoints are equal — see
    // `movementSentence`. Taken off the points this panel actually PLOTS, so
    // the sentence cannot name a month the line does not draw.
    furthestFrom(points, first, prose),
  )];
  // A PANEL THAT DOES NOT SHARE THE SCALE SAYS SO, IN ITS OWN TITLE. The
  // page's scale note names it too; this is the half a reader meets while
  // looking at the line, which is where a rescaled axis actually misleads.
  if (!drawn.shared) {
    // SHORT. A panel's title is drawn INSIDE its 37.6mm box, so every line of
    // it is a line the chart does not get: the first wording ran to three
    // lines and took a third of the plot with it. The page's Scale note
    // carries the argument; this carries the fact.
    //
    // "Own scale — 1.1% of the shared range" read as a contradiction: the
    // panel appeared to claim both that it is off the shared scale and that
    // it occupies a share of it. Both were true and the sentence did not say
    // how — the percentage is WHY the panel is off, not where it sits. Said
    // as the reason it is.
    // THROUGH THE PACK'S OWN PERCENTAGE FORMATTER, not `${n}%`. A share of
    // exactly one per cent printed "1%" beside a sibling reading "1.6%",
    // because `Math.round(x * 1000) / 10` is a NUMBER and a number has no
    // trailing zero — two panels apart, on the sheet whose argument is that
    // its figures are checked. `formatPctLevel` is the same one-decimal
    // level the rest of the pack prints, so the drift cannot come back by a
    // third call site interpolating its own.
    clauses.push(`Own scale: its axis is ${formatPctLevel(drawn.ownSharePct)} of the shared one, `
      + 'too little to show on it.');
  }
  // AND THE MONTH THAT SETS THE SCALE IS NAMED ON THE PANEL THAT CARRIES IT.
  // The rendered demo pack drew a spike of +1 908 in one month on a page
  // whose income statement totals (1 546) for the period, and no title, note
  // or caption anywhere in the document mentioned it.
  // AND THE TITLE KEEPS TO THREE LINES. At four, the last one sat on the
  // panel's top tick ("1 908") and set the plot lower than its neighbour's;
  // `packPanelTitlesFit.test.ts` measures every panel on every fixture.
  if (dominant !== null) {
    const because = dominant.creditMonth === null ? '' : `, ${dominant.creditMonth}`;
    // "sets N% of the scale" was a THIRD percentage on a page already
    // carrying two, measuring something else again — how much of the shared
    // span goes away when this point does. Said as what it is.
    // AND IT IS THE SHARED RANGE, NAMED. The clause sits in the NET PROFIT
    // panel's caption — that is the panel carrying the scale-setting month —
    // and the two bounds it prints belong to neither: on the demo pack
    // "(1 621) to 58" is cash's low and operating expenses' high. Both
    // figures are right and the sentence was attributed where a director
    // checks the wrong column, going looking in the net profit series for a
    // 58 it does not contain. The word "shared" is what points them at the
    // page's own Scale note and at the commentary line that states the same
    // span; it costs the caption six characters and no page millimetres,
    // because a panel title is drawn inside the chart's own fixed box.
    // AND THE RANGE THAT IS LEFT IS PRINTED, not implied. "shrinks by 52.4%"
    // stood on a sheet that stated the shared span and this month and nothing
    // else, so the only way to check the percentage was to know a
    // next-highest month of 59 that appeared nowhere in the pack — the one
    // claim on the page a reader could not test, on a page whose argument is
    // that they can test all of them.
    clauses.push(
      `Without ${dominant.label} (${prose(dominant.value)}${because}) the SHARED range `
      + `is ${dominant.residualRange}, ${formatPctLevel(dominant.sharePct)} narrower.`,
    );
  }
  return {
    id: panel.id,
    title: clauses.join(' '),
    kind: 'line',
    sharedScale: drawn.shared,
    svg: renderChartSvg(panelAxisLabels(smallMultipleOption(points, drawn.domain, money, undefined, { endpoints: true }), drawn.domain), PANEL),
    plotMm: PANEL.heightMm,
    heightMm: PANEL.heightMm,
  };
}

/**
 * A ratio panel, or null when no month in the window has a meaningful value
 * — e.g. a company with no revenue at all across the whole trend. Months
 * where the ratio is not meaningful (R-P44/R-P45: no revenue that month) are
 * dropped from the line rather than plotted as a false zero; a gap in the
 * series is honest, a zero is a claim about a debtor book that collected
 * nothing.
 */
/**
 * THE POINT FURTHEST FROM THE FIRST, where that is not the first itself.
 *
 * `trendsTitle` does exactly this for revenue and prints "(5 535) at its
 * furthest, in Apr 2026"; a panel whose endpoints are equal needs the same
 * fact, and taking it here means the title and the caption beneath it are
 * about one measurement. Undefined on a series that never leaves its opening
 * value, which is the genuinely flat case.
 */
function furthestFrom(
  points: ReadonlyArray<{ label: string; value: number }>,
  first: number,
  prose: (n: number) => string,
): { value: string; month: string } | undefined {
  const far = points.reduce((best, point) =>
    Math.abs(point.value - first) > Math.abs(best.value - first) ? point : best, points[0]!);
  return far.value === first ? undefined : { value: prose(far.value), month: far.label };
}

/** The last month a ratio panel actually PLOTS — which is the last month it
 *  could measure, not the last month of the window. Shared with `ratioPanel`,
 *  whose title marks that same point, so the panel and the page cannot
 *  disagree about which month a ratio ends on. */
export function ratioTerminal(panel: RatioPanel, trend: PackTrendPoint[]): PackTrendPoint | undefined {
  const drawn = trend.filter((point) => panel.pick(point) !== null);
  return drawn[drawn.length - 1];
}

export function ratioPanel(panel: RatioPanel, trend: PackTrendPoint[], scale: MoneyScale): PackChartSpec | null {
  const drawn = trend.filter((point) => panel.pick(point) !== null);
  const points = drawn.map((point) => ({ label: monthLabel(point), value: panel.pick(point) as number }));
  if (points.length === 0) return null;

  const domain = sharedDomain([points.map((p) => p.value)]);
  const first = points[0]!.value;
  const last = points[points.length - 1]!.value;
  const prose = (n: number) => inProse(panel.format(n));
  // AND IT SAYS SO, LIKE THE MONEY PANELS DO. A gross margin running from
  // (4267.6%) to 100.0% and a debtor-day count from 0.0 to 60.5 cannot be on
  // a scale spanning (1 621) to 1 908 R'000, and neither carried the note the
  // two rescaled money panels carry — so silence read as membership, and the
  // sheet presented four different scales as one shared scale plus two
  // exceptions. The reason is different from a money panel's and is stated as
  // such: this panel is not in rands at all.
  // A RATIO PANEL DROPS THE MONTHS IT CANNOT MEASURE, so the point it ends on
  // is the last month it COULD measure — which is the stub where the stub has
  // a value, and is not where it does not. Read off `drawn`, the series
  // actually plotted, rather than off the window: page 10's gross-margin
  // panel is exactly the case, ending on a 100.0% taken over seven days.
  const terminal = ratioTerminal(panel, trend)!;
  const title = movementSentence(
    panel.name, prose(first), prose(last), points.length, last >= first,
    terminal.partial ? monthLabel(terminal) : undefined,
    furthestFrom(points, first, prose),
  ) + ` Own scale: ${panel.unit}, not ${scale}.`;
  return {
    id: panel.id,
    title,
    kind: 'line',
    // A ratio panel is in its OWN unit, so it never shared the money domain
    // and cannot be read against it. Reported rather than left undefined, so
    // the page's scale note is derived from the panels rather than from a
    // second list of which ones are money.
    sharedScale: false,
    svg: renderChartSvg(panelAxisLabels(smallMultipleOption(points, domain, panel.format, undefined, { endpoints: true }), domain), PANEL),
    plotMm: PANEL.heightMm,
    heightMm: PANEL.heightMm,
  };
}
