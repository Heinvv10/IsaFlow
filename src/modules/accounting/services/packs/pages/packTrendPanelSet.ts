/**
 * Page 10's panel set — the box every small multiple is drawn in, and the six
 * panels the trends page names, money and ratio. Moved out of
 * `packTrendCharts.ts` unchanged to keep that file under the 300-line cap;
 * `packTrendCharts.ts` re-exports `TRENDS_PANELS_SPECIFIED`.
 */

import { formatDays, formatPctLevel } from '@/lib/format/money';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

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
export const PANEL = { widthMm: 83, heightMm: 28 };

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

export interface MoneyPanel { id: string; name: string; pick: (p: PackTrendPoint) => number }
export interface RatioPanel {
  id: string;
  name: string;
  pick: (p: PackTrendPoint) => number | null;
  /** How the panel's own end-label formats a value — a percentage and a day
   *  count are not printed through `formatStatementFigure`. */
  format: (n: number) => string;
  /** The unit in words, for the panel's own "Own scale" clause — "a
   *  percentage", "a day count". Named rather than derived from `format`,
   *  because a formatter is not a noun. */
  unit: string;
}

export const MONEY_PANELS: MoneyPanel[] = [
  { id: 'trend-revenue', name: 'Revenue', pick: (p) => p.revenue },
  { id: 'trend-operating-expenses', name: 'Operating expenses', pick: (p) => p.operatingExpenses },
  { id: 'trend-net-profit', name: 'Net profit', pick: (p) => p.netProfit },
  { id: 'trend-cash', name: 'Cash', pick: (p) => p.cash },
];

export const RATIO_PANELS: RatioPanel[] = [
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
