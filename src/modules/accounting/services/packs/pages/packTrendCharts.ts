/**
 * The board pack's TREND charts — page 10's small multiples and page 8's
 * closing-cash line — split out of `packPageCharts.ts`, which was at the
 * 300-line cap when the profit bridge gained its residual step.
 *
 * The split follows the shape of the work rather than the line count: a
 * BRIDGE asserts arithmetic between two endpoints and is what the integrity
 * gate walks; a TREND draws a level over time and asserts nothing that can be
 * footed. Nothing below changed in the move. `packPageCharts.ts` re-exports
 * every name here, so existing import paths still resolve.
 */

import { PAGE_WIDTH_MM } from './packTextMetrics';
import { svgBoxFor } from './packChartBox';
import { formatDays, formatMoney, formatPctLevel, inProse, inScale, MONEY_SCALES, type MoneyScale } from '@/lib/format/money';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import { sharedDomain, smallMultipleOption } from '@/modules/accounting/services/packs/packLineChartOptions';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import {
  creditMonthClause,
  dominantPoint,
  moneyPanelScales,
  movementSentence,
  type Domain,
  type ScaleDominator,
} from './packTrendScale';
import { monthLabel, partialMonthClause } from './packPartialMonth';
import type { PackChartSpec } from './packPageModel';

/**
 * A page-10 panel: 83mm wide, 48mm tall, TWO ACROSS ON A PORTRAIT SHEET.
 *
 * It was 82 x 36, three across, on the one landscape sheet in a
 * twelve-sheet portrait pack. Landscape was chosen to fit six panels in two
 * rows, and it cost more than it bought: printed and bound, one sheet in
 * twelve turns sideways, and a 168mm content box left the page the tightest
 * in the pack — 0.9mm of slack on Brightsphere, which is what made its
 * disclosures the first prose the fitter took.
 *
 * Two across is 83mm a panel — within a millimetre of the old measure — and
 * three rows of 48mm plus their gutters come to 160mm in a 255mm box. The
 * page gains a third more panel height, which is the other half of what the
 * trends page needed (three of its panels were drawing one to two pixels of
 * excursion), and the pack stops having a sheet that reads sideways.
 *
 * 44mm rather than spec §5.6's 48mm inline rung, and the rung is the thing
 * that gives: this is the only page in the pack that carries THREE rows of
 * charts, and the rungs were set for a page carrying one. At 48 the demo
 * pack's trends page measured 255.8mm in a 255mm box and `fitPageToBox`
 * dropped a disclosure to pay for the 0.8 — printing "1 explanatory note is
 * not printed" on the one page whose panels are drawn on two different
 * scales, which is the note a reader most needs. 44 leaves 12mm of headroom
 * and is still a fifth taller than the 36mm the landscape sheet allowed.
 *
 * AND 44 WAS THE FIGURE — CAPTION AND PLOT TOGETHER, WHICH IS WHY THE SHARED
 * SCALE DID NOT REACH THE PAPER. The caption was drawn inside the fixed box
 * and the plot took what was left, so net profit's two-line title gave it
 * 123.3 page pixels of plot against the five one-line panels' 142.0 — the
 * money group's one y-domain painted at 0.74275 page pixels per user unit on
 * one panel and 0.85523 on the others, 13.2% apart, on a page whose caption
 * says the scale is shared. `heightMm` is now the PLOT BOX alone and the
 * caption is charged on top of it.
 *
 * 30mm, DOWN FROM 37.6, AND THE PAGE'S TWO NOTES ARE WHAT IT BUYS. The
 * six-panel sheet needed 273mm of a 255mm box once each panel's axis carried
 * its own low and high and the two ratio panels said which scale they are on,
 * so the fitter took both notes from "Reading these panels" and printed a line
 * telling the board it had done so — on the one page whose own claims those
 * notes make checkable. Three of the eighteen millimetres came off the caption
 * (8.5pt over an 83mm measure, the pack's glossary size), and the rest come off
 * the plot. It is still a third taller than the 22mm the landscape sheet's
 * 36mm figure left after its caption, and the panels no longer need the height
 * they were given: what made three of them draw one to two pixels of excursion
 * was the shared domain, and `packTrendScale` moves a panel off it rather than
 * growing the page.
 */
/**
 * 28, DOWN FROM 30, AND WHAT IT BUYS IS THE PART-MONTH MARKER.
 *
 * The series ends on the month CONTAINING the reporting date, so on a pack
 * run mid-month the terminal point of every panel is a stub — seven days on
 * the pack the visual gate read, which is how a gross margin of 100.0% came
 * to be printed as where margin currently stands. Naming that month inside
 * each panel's own movement sentence costs one caption line on the tallest
 * panel of each row: 4.2mm on a page that fitted with a tenth of a
 * millimetre to spare.
 *
 * Two millimetres a row is where it comes from. The alternative was the
 * page's two "Reading these panels" notes, which are what make its own
 * percentage claims checkable, and a plot band is the cheaper of the two: at
 * 28 the panels are still a quarter taller than the 22mm the old landscape
 * sheet left after its caption, and the excursion problem that made three of
 * them draw one to two pixels was solved by `packTrendScale` moving a panel
 * off the shared domain, not by height.
 */
const PANEL = { widthMm: 83, heightMm: 28 };

/**
 * Page 10 — the small multiples.
 *
 * Spec §4.A names six panels: revenue, gross margin %, operating expenses,
 * net profit, cash and debtor days. All six are drawn from `PackTrendPoint`'s
 * series.
 *
 * They do NOT all share one y-domain: gross margin % and debtor days are
 * different UNITS from the four money series (Rand vs a percentage, Rand vs
 * a day count), and a shared scale across units is not a wider view of the
 * same row, it is nonsense — a 45% gross margin plotted against a R4.2m
 * revenue axis is indistinguishable from zero. Grouped instead:
 *   - money:  revenue, operating expenses, net profit, cash — one domain.
 *   - each ratio panel (gross margin %, debtor days) keeps its OWN domain,
 *     because the two are themselves different units from each other.
 * Within the money group the shared-scale rule from spec §4.A still holds in
 * full: per-panel autoscaling there would draw a flat metric and a
 * collapsing one with the same apparent slope, which is the failure the rule
 * exists to stop.
 */
export const TRENDS_PANELS_SPECIFIED = 6;

interface MoneyPanel { id: string; name: string; pick: (p: PackTrendPoint) => number }
interface RatioPanel {
  id: string;
  name: string;
  pick: (p: PackTrendPoint) => number | null;
  /** How the panel's own end-label formats a value — a percentage and a day
   *  count are not printed through `formatMoney`. */
  format: (n: number) => string;
  /** The unit in words, for the panel's own "Own scale" clause — "a
   *  percentage", "a day count". Named rather than derived from `format`,
   *  because a formatter is not a noun. */
  unit: string;
}

const MONEY_PANELS: MoneyPanel[] = [
  { id: 'trend-revenue', name: 'Revenue', pick: (p) => p.revenue },
  { id: 'trend-operating-expenses', name: 'Operating expenses', pick: (p) => p.operatingExpenses },
  { id: 'trend-net-profit', name: 'Net profit', pick: (p) => p.netProfit },
  { id: 'trend-cash', name: 'Cash', pick: (p) => p.cash },
];

const RATIO_PANELS: RatioPanel[] = [
  { id: 'trend-gross-margin', name: 'Gross margin', pick: (p) => p.grossMarginPct, format: (n) => formatPctLevel(n), unit: 'a percentage' },
  // ONE DECIMAL RULE FOR A DAY COUNT, WHICH IS NONE. This panel printed
  // "18.6 days" and "59.6 days" while the scorecard and the highlights
  // printed "213 days", "789 days" and "1 035 days" — the same label, two
  // precisions, two sheets apart. The two ARE on different bases and the
  // pack discloses that on both pages, but precision is not how a reader
  // tells one basis from another: it reads as one of the two being more
  // exact. `formatDays`' own default is the whole-day form the rest of the
  // pack uses, so the panel now takes it too.
  { id: 'trend-debtor-days', name: 'Debtor days', pick: (p) => p.debtorDays, format: (n) => formatDays(n), unit: 'a day count' },
];

/**
 * A FIGURE AS THE SHEET PRINTS IT, in the scale's own units.
 *
 * Page 10 invites the reader to check a share off the sheet — every panel
 * labels the ends of its own axis and the note states the shared span — and
 * the invitation did not survive the arithmetic. The shares were computed on
 * raw rands and the axes print thousands: an operating-expenses range of
 * 58 452 over a shared span of 3 528 000 is 1.66%, printed 1.7%, while the
 * reader divides the 58 and the 3 528 in front of them and gets 1.6%. The
 * figure was not wrong; the check the page asked for did not reproduce, and
 * on a page whose whole argument is that its scales are checkable that is
 * the more expensive of the two.
 *
 * So every number in that arithmetic is now the number the reader can see:
 * the shared span is the difference of the two PRINTED extremes (not a
 * separately rounded difference, which is how "1 908" and "(1 621)" came to
 * be published beside a span of 3 528 rather than 3 529), and each panel's
 * share is its own printed range over that. Nothing else moves — which
 * panels sit on the shared scale is still decided on the unrounded spans in
 * `packTrendScale`, because a threshold that wobbles with a rounding is a
 * threshold that changes a drawing for no reason.
 */
function atScale(value: number, scale: MoneyScale): number {
  const divisor = MONEY_SCALES[scale];
  // Away from zero at the half, which is what `Intl.NumberFormat` does and
  // `Math.round` does not for a negative.
  return Math.sign(value) * Math.round(Math.abs(value) / divisor);
}

/** The printed span of a domain, in the scale's units. */
function printedSpan(domain: Domain, scale: MoneyScale): number {
  return atScale(domain.max, scale) - atScale(domain.min, scale);
}

/** A panel's own printed range as a percentage of the printed shared span,
 *  to one decimal — the number the panel's title states, reproducible from
 *  the four figures the sheet prints. */
function printedSharePct(own: Domain, sharedSpan: number, scale: MoneyScale): number {
  if (sharedSpan === 0) return 100;
  return Math.round((printedSpan(own, scale) / sharedSpan) * 1000) / 10;
}

/** A domain as the sheet prints its two ends — "(1 621) to 59". The same two
 *  numbers the shared range is stated with, through the same formatter. */
function printedRange(domain: Domain, scale: MoneyScale): string {
  return `${inProse(formatMoney(domain.min, { scale }))} to `
    + `${inProse(formatMoney(domain.max, { scale }))}`;
}

/** How much of the printed shared span the printed residual range gives up,
 *  to one decimal — the subtraction a reader does on the sheet. */
function printedShrinkPct(sharedSpan: number, residual: Domain, scale: MoneyScale): number {
  if (sharedSpan === 0) return 0;
  return Math.round(((sharedSpan - printedSpan(residual, scale)) / sharedSpan) * 1000) / 10;
}

function moneyPanel(
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
  const money = (n: number) => formatMoney(n, { scale });
  const prose = (n: number) => inProse(money(n));
  // AND THE SENTENCE SAYS WHICH MONTH ITS LAST FIGURE IS, where that month is
  // a stub. "Revenue rose from nil to 30 over 12 periods" states a current
  // position measured over seven days of September; unmarked, that is the
  // sentence a director repeats back in the meeting.
  const terminal = trend[trend.length - 1];
  const clauses = [movementSentence(
    panel.name, prose(first), prose(last), points.length, last >= first,
    terminal !== undefined && terminal.partial ? monthLabel(terminal) : undefined,
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
  if (dominant !== null) {
    const because = dominant.creditMonth === null ? '' : ` — ${dominant.creditMonth}`;
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
      `${dominant.label} alone is ${prose(dominant.value)}${because}; drop it and the SHARED range `
      + `becomes ${dominant.residualRange}, ${formatPctLevel(dominant.sharePct)} narrower.`,
    );
  }
  return {
    id: panel.id,
    title: clauses.join(' '),
    kind: 'line',
    sharedScale: drawn.shared,
    svg: renderChartSvg(smallMultipleOption(points, drawn.domain, money, undefined, { endpoints: true }), PANEL),
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
/** The last month a ratio panel actually PLOTS — which is the last month it
 *  could measure, not the last month of the window. Shared with `ratioPanel`,
 *  whose title marks that same point, so the panel and the page cannot
 *  disagree about which month a ratio ends on. */
function ratioTerminal(panel: RatioPanel, trend: PackTrendPoint[]): PackTrendPoint | undefined {
  const drawn = trend.filter((point) => panel.pick(point) !== null);
  return drawn[drawn.length - 1];
}

function ratioPanel(panel: RatioPanel, trend: PackTrendPoint[], scale: MoneyScale): PackChartSpec | null {
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
    svg: renderChartSvg(smallMultipleOption(points, domain, panel.format, undefined, { endpoints: true }), PANEL),
    plotMm: PANEL.heightMm,
    heightMm: PANEL.heightMm,
  };
}

/**
 * Page 10's panels, and what the page has to SAY about the scale they are
 * drawn on.
 *
 * One decision, made here and reported, rather than two: `packPageBlocks`
 * writes the page's scale note off this result instead of recomputing which
 * panels share a domain. The note used to be a fixed sentence naming four
 * money panels, which was false on any pack that drew fewer.
 */
export interface TrendPanels {
  panels: PackChartSpec[];
  /** Money panels drawn on the shared y-domain, by name, in draw order. */
  sharedScale: string[];
  /** Money panels moved to their own domain, with the share of the shared
   *  range each occupies. */
  ownScale: Array<{ name: string; sharePct: number }>;
  /** Panels in a unit of their own — a percentage, a day count. */
  ownUnits: string[];
  /**
   * Ratio panels whose LAST plotted month is the part month, by name.
   *
   * A tag says WHICH month a figure belongs to; it does not say that a RATIO
   * taken over seven of thirty days is an artefact of the window rather than
   * a movement in the business. Page 10 quoted "Gross margin fell from
   * 5323.5% to 100.0% in Sep 2026 (part)" — seven days of revenue against no
   * cost of sales yet posted — and "Debtor days rose from 19 days to 60 days
   * in Sep 2026 (part)", a seven-day ratio annualised over a whole month.
   * Both carried the marker and a director still reads 100.0% as a
   * turnaround. The money panels do not have this problem: a part month's
   * REVENUE is a smaller true figure, while a part month's MARGIN is a
   * different measurement.
   *
   * Named rather than counted, and read off the months each panel actually
   * PLOTTED — a ratio panel drops the months it cannot measure, so the point
   * it ends on is not always the end of the window.
   */
  ratiosEndingOnPartMonth: string[];
  /**
   * Drawn panels that plot FEWER months than the window, by name.
   *
   * `ratioPanel` drops the months it cannot measure rather than plotting a
   * false zero, which is right and was unstated: two of the live demo pack's
   * six panels — gross margin and debtor days — run Jul 2026 to Sep 2026
   * (part) and say "over 3 periods" in their own titles, because revenue is
   * nil before July and neither ratio is defined without it. Page 5 then
   * claimed the twelve-month window "is the series page 10 draws", which the
   * two shortened panels disprove three centimetres away.
   *
   * Brightsphere carries the OMISSION rule already ("A panel is omitted when
   * its figure is not meaningful in every period of the window") and all four
   * of its drawn panels are twelve periods, so its copy of that sentence was
   * true — which is why fourteen gates read it and only the fifteenth put the
   * two packs side by side. The two behaviours are one rule once both halves
   * are stated: omit where the measure exists nowhere in the window, shorten
   * where it exists in part of it.
   *
   * Named rather than counted, because the disclosure names them.
   */
  shortenedPanels: string[];
  /**
   * The shared y-domain in words — "(707) to 1 908, a span of 2 615" — so the
   * page can STATE the denominator its percentages are taken against.
   *
   * Two panels claimed "1.1% of the shared range" and "1.7%" and the page
   * printed nothing a reader could check them against; a reviewer took the
   * spans off the two figures in each panel's own title (2 to 29, 15 to 41),
   * got near-identical numbers, and reported the claims as irreconcilable.
   * They are not — the percentage is the span of a panel's own AXIS, whose
   * two ends the panel prints, over the shared span, not the movement
   * between its first and last month — but
   * a claim a reader cannot check is a disclosure failure whether or not the
   * arithmetic is right.
   *
   * Null where no money panel is drawn.
   */
  sharedRange: string | null;
}

export function buildTrendPanels(trend: PackTrendPoint[], scale: MoneyScale): TrendPanels {
  if (trend.length === 0) {
    return {
      panels: [], sharedScale: [], ownScale: [], ownUnits: [],
      ratiosEndingOnPartMonth: [], shortenedPanels: [], sharedRange: null,
    };
  }

  // ONE y-domain across the money panels (spec §4.A page 10) for every panel
  // that can be read against it. Per-panel autoscaling would draw a flat
  // metric and a collapsing one with the same apparent slope, which is a
  // chart that misreports direction — so a panel only leaves the shared
  // domain when its own range is too small to register on it, and it says so
  // when it does. See `packTrendScale.ts`.
  const series = MONEY_PANELS.map((panel) => trend.map(panel.pick));
  const { shared, panels: rawScales } = moneyPanelScales(series);
  const dominator: ScaleDominator | null = dominantPoint(series);

  // EVERY PERCENTAGE THIS PAGE PRINTS IS THE ONE THE PRINTED FIGURES GIVE —
  // see `atScale`. The domains, and which panel sits on which, are untouched.
  const sharedSpan = printedSpan(shared, scale);
  const scales = rawScales.map((panelScale) => ({
    ...panelScale,
    ownSharePct: printedSharePct(panelScale.domain, sharedSpan, scale),
  }));

  const money = MONEY_PANELS.map((panel, i) => {
    const carriesDominator = dominator !== null && dominator.seriesIndex === i;
    const point = carriesDominator ? trend[dominator.pointIndex] : undefined;
    return moneyPanel(panel, trend, scale, scales[i]!, point === undefined || dominator === null
      ? null
      : {
        // Marked, like every other month this pack names — the scale-setting
        // month can be the stub.
        label: monthLabel(point),
        value: dominator.value,
        // THE PRINTED PERCENTAGE OFF THE PRINTED FIGURES, exactly as
        // `printedSharePct` does for a panel's own share — see `atScale`. The
        // reader subtracts the two ranges the sheet prints; the number beside
        // them has to be the one that subtraction gives.
        sharePct: printedShrinkPct(sharedSpan, dominator.residual, scale),
        residualRange: printedRange(dominator.residual, scale),
        creditMonth: creditMonthClause(point),
      });
  });

  // Spec order: revenue, gross margin %, operating expenses, net profit,
  // cash, debtor days.
  const panels: PackChartSpec[] = [
    money[0]!,
    ratioPanel(RATIO_PANELS[0]!, trend, scale),
    money[1]!,
    money[2]!,
    money[3]!,
    ratioPanel(RATIO_PANELS[1]!, trend, scale),
  ].filter((p): p is PackChartSpec => p !== null);

  return {
    panels,
    sharedScale: MONEY_PANELS.filter((_, i) => scales[i]!.shared).map((p) => p.name),
    ownScale: MONEY_PANELS
      .map((p, i) => ({ name: p.name, sharePct: scales[i]!.ownSharePct, shared: scales[i]!.shared }))
      .filter((p) => !p.shared)
      .map(({ name, sharePct }) => ({ name, sharePct })),
    ownUnits: RATIO_PANELS.filter((p) => panels.some((drawn) => drawn.id === p.id)).map((p) => p.name),
    ratiosEndingOnPartMonth: RATIO_PANELS
      .filter((p) => panels.some((drawn) => drawn.id === p.id))
      .filter((p) => ratioTerminal(p, trend)?.partial === true)
      .map((p) => p.name),
    // Only the ratio panels can shorten: a money panel plots every month of
    // the window by construction, because a month with nothing posted is a
    // true nil rather than an unmeasurable one. Counted off the same `pick`
    // the panel itself draws from, so the list cannot disagree with the
    // titles that say "over N periods".
    shortenedPanels: RATIO_PANELS
      .filter((p) => panels.some((drawn) => drawn.id === p.id))
      .filter((p) => trend.filter((point) => p.pick(point) !== null).length < trend.length)
      .map((p) => p.name),
    // The span is the difference of the two extremes AS PRINTED, so the
    // subtraction a reader does on the sheet gives the number the sheet
    // states. `shared.max - shared.min` rounded separately does not: the
    // live demo page published "1 908", "(1 621)" and "a span of 3 528".
    // AND THE UNIT IN THE FORM PROSE STATES ONE IN — see `inScale`. It read
    // "a span of 3 529 R'000", the column banner shoved against a figure,
    // which is a third position for a unit the pack otherwise only ever
    // sets above the column it governs.
    sharedRange: `${inProse(formatMoney(shared.min, { scale }))} to `
      + `${inProse(formatMoney(shared.max, { scale }))}, a span of `
      + `${inScale(inProse(formatMoney(sharedSpan * MONEY_SCALES[scale], { scale })), scale)}`,
  };
}

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
    svg: renderChartSvg(
      // LABELLED, unlike a page-10 panel. This one is on the page's own text
      // measure and is the only picture of cash a director gets; bare, it
      // was six gridlines carrying one number.
      smallMultipleOption(points, domain, (n) => formatMoney(n, { scale }), undefined, { unit: scale }),
      cashPlot,
    ),
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
