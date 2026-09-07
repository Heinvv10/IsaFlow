/**
 * WHICH OF PAGE 10'S MONEY PANELS CAN SHARE ONE Y-SCALE, AND WHAT THE SHARED
 * SCALE COSTS THE ONES THAT CANNOT.
 *
 * Spec §4.A asks the money panels to share a domain, and the reason is sound:
 * per-panel autoscaling draws a flat metric and a collapsing one with the
 * same apparent slope, so a reader reads direction off a chart that has
 * silently rescaled under them. That rule is kept. What it did not survive
 * was a single month.
 *
 * On the live demo pack one month — July 2026 — carried a net profit of
 * +1 908 R'000 against a period result of (1 546), because expenses that
 * month were a NET CREDIT: seven payroll journals dated outside the window
 * were reversed into it. That one point sets 69% of the shared domain, and
 * revenue (a range of 37) and operating expenses (a range of 40) were then
 * drawn across two thousand seven hundred units of scale. Their total
 * vertical excursion on the printed sheet was one to two pixels: three panels
 * whose titles did all the work and whose lines carried no information at
 * all.
 *
 * SO THE SPLIT IS STATED RATHER THAN THE SCALE ABANDONED. A panel whose own
 * range is a twentieth or less of the shared range is drawn on its own
 * domain and SAYS SO in its own title, and page 10's scale note is derived
 * from which panels ended up where. That is the IBCS answer to a scale
 * difference — indicate it, do not hide it — and it is the one presentation
 * that keeps the comparison honest for the panels that can bear it while
 * letting the small ones show their movement.
 *
 * Nothing here reads a chart or renders one; it decides domains and reports
 * what it decided, so `packTrendCharts.ts` can draw and `packPageBlocks.ts`
 * can write the sentence, off ONE decision rather than two.
 */
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

export interface Domain {
  min: number;
  max: number;
}

/**
 * A panel whose own range is at or under this share of the shared range is
 * drawn on its own scale.
 *
 * A twentieth, because that is roughly where a 36mm panel stops being able to
 * show anything: a series with 5% of the domain has 1.8mm of travel, and the
 * 2pt line drawn through it is 0.7mm thick. Below that the panel is a
 * horizontal rule with a title. Above it, the shared scale still tells the
 * reader something true about relative magnitude, which is the whole reason
 * the panels are drawn together.
 */
export const OWN_SCALE_SHARE = 0.05;

/**
 * A single month that accounts for more than this share of the shared
 * domain's span is reported as setting the scale.
 *
 * Half, deliberately: at that point the domain is more about one month than
 * about the twelve, and every other panel on the page is being drawn against
 * it. Below half it is a large month; above it, it is the scale.
 */
export const DOMINANT_MONTH_SHARE = 0.5;

/** The domain a row of series shares — the widest of them decides it, and
 *  zero is always inside it so a reader can see which side of break-even a
 *  panel sits on. Same rule as `sharedDomain`, restated over one series. */
function domainOf(values: number[]): Domain {
  return { min: Math.min(0, ...values), max: Math.max(0, ...values) };
}

const spanOf = (d: Domain): number => d.max - d.min;

export interface PanelScale {
  /** The domain this panel is drawn against. */
  domain: Domain;
  /** True where that domain is the money group's shared one. */
  shared: boolean;
  /** This panel's own range as a percentage of the shared range, to one
   *  decimal — what the panel's title states when it is on its own scale. */
  ownSharePct: number;
}

/**
 * The domain for each money series, and whether it is the shared one.
 *
 * A series is only ever moved OFF the shared scale, never onto a wider one:
 * the shared domain is computed across all of them first, exactly as before,
 * and a panel keeps it unless its own range is too small to draw against it.
 */
export function moneyPanelScales(series: number[][]): { shared: Domain; panels: PanelScale[] } {
  const shared = domainOf(series.flat());
  const sharedSpan = spanOf(shared);
  const panels = series.map((values) => {
    const own = domainOf(values);
    const share = sharedSpan === 0 ? 1 : spanOf(own) / sharedSpan;
    // A degenerate own domain (a series that never leaves zero) has nothing
    // to gain from its own scale and would be drawn against a zero-height
    // axis, so it keeps the shared one.
    const onOwn = share <= OWN_SCALE_SHARE && spanOf(own) > 0;
    return {
      domain: onOwn ? own : shared,
      shared: !onOwn,
      ownSharePct: Math.round(share * 1000) / 10,
    };
  });
  return { shared, panels };
}

/**
 * The one month, if there is one, that sets the shared scale for everything
 * else on the page.
 *
 * Found by removing the value furthest from zero and re-measuring the span:
 * that is the question a reader is actually asking ("how much of this axis is
 * one month?"), and it is answerable without a distribution or a threshold on
 * the value itself. A ratio against the second-largest value would fire on a
 * series that is simply growing.
 */
export interface ScaleDominator {
  /** Which of the `series` rows carries it. */
  seriesIndex: number;
  /** Which point of that row. */
  pointIndex: number;
  value: number;
  /** How much of the shared span disappears when the point does, to one
   *  decimal — the figure the page prints. */
  sharePct: number;
}

export function dominantPoint(series: number[][]): ScaleDominator | null {
  const shared = domainOf(series.flat());
  const span = spanOf(shared);
  if (span === 0) return null;

  let found: { seriesIndex: number; pointIndex: number; value: number } | null = null;
  for (const [seriesIndex, values] of series.entries()) {
    for (const [pointIndex, value] of values.entries()) {
      if (found === null || Math.abs(value) > Math.abs(found.value)) {
        found = { seriesIndex, pointIndex, value };
      }
    }
  }
  if (found === null) return null;

  const without = series.map((values, i) =>
    (i === found!.seriesIndex ? values.filter((_, j) => j !== found!.pointIndex) : values));
  const reduction = (span - spanOf(domainOf(without.flat()))) / span;
  if (reduction <= DOMINANT_MONTH_SHARE) return null;
  return { ...found, sharePct: Math.round(reduction * 1000) / 10 };
}

/**
 * WHY A MONTH CAN SHOW A PROFIT ON A PERIOD THAT SHOWS A LOSS.
 *
 * The pack's monthly net profit is `revenue − expenses` over the postings
 * dated in that month, which is the same definition the income statement
 * applies to the whole period. The two therefore reconcile, and a director
 * comparing the trends page's spike against a period income statement whose
 * total inflows are R111k is entitled to be told how — otherwise the largest
 * visual event in the document is one the pack does not acknowledge.
 *
 * What produced it is visible in the series itself: a month whose EXPENSES
 * are a net credit is a month in which more was reversed out of expense
 * accounts than was posted into them. That is a statement about the ledger,
 * derived from two fields the trend already carries, and it names no journal
 * this model has not read.
 *
 * Null where the point is not explained by a credit to expenses — a genuinely
 * large trading month needs no note, and inventing one would be worse than
 * silence.
 */
export function creditMonthClause(point: PackTrendPoint): string | null {
  return point.expenses < 0 ? 'expenses that month were a net credit' : null;
}

/**
 * A PANEL'S OPENING SENTENCE, WITH ITS FIGURES AS WORDS.
 *
 * Brightsphere rendered three titles reading "Revenue rose from – to – over
 * 12 periods" — a claimed rise with a dash where each figure belongs —
 * because both endpoints were nil and every formatter prints a measured zero
 * as an en dash, which is right in a money column and is not a word in a
 * sentence. `inProse` supplies "nil"; and where both ends are the same there
 * is no movement to name, so the sentence stops claiming one.
 *
 * It lives here rather than in `packTrendCharts.ts` for the 300-line cap, and
 * beside the scale split because the two are the same job: what a panel has
 * to tell a reader about how it is drawn.
 *
 * @param first `inProse(...)` of the first month's figure, in the panel's own
 *   unit — never a raw number, so a caller cannot format it a second way.
 * @param rose Whether the last value is at or above the first. Taken from the
 *   NUMBERS, because two formatted strings cannot be compared for order.
 */
export function movementSentence(
  name: string,
  first: string,
  last: string,
  periods: number,
  rose: boolean,
): string {
  if (first === last) {
    const level = first === 'nil' ? 'nil' : `unchanged at ${last}`;
    return `${name} is ${level} in both the first and the last month of the ${periods}-month series.`;
  }
  return `${name} ${rose ? 'rose' : 'fell'} from ${first} to ${last} over ${periods} periods.`;
}
