/**
 * PAGE 9 IS FIVE TABLES AND WAS NOT ONE GRID.
 *
 * The scorecard prints a `<table>` per lettered group, and each one sized its
 * own columns from its own content — `table-layout: auto`, which is what a
 * browser does when nothing says otherwise. The CSS pinned the METRIC column
 * at 34% and the TREND column at 18mm and left a comment claiming that "keeps
 * the Actual/Target/Prior/Trend/Status columns aligned across every group's
 * table". It does not, and it never did: fixing two columns still leaves the
 * remaining width distributed by content, per table.
 *
 * Measured on the rendered demo page at 260 dpi, header right edges:
 *
 *   block                ACTUAL  TARGET  PRIOR
 *   A Profitability        1072    1356   1589
 *   B Liquidity            1048    1327   1572
 *   C Working capital      1039    1292   1607
 *   D Leverage             1009    1251   1462
 *   E Cash flow            1009    1251   1462
 *
 * TARGET moves about 10mm between blocks and PRIOR about 14mm, and PRIOR moves
 * NON-MONOTONICALLY — C sits to the right of A, then D jumps left. `+35.0%`,
 * `1.50`, `30 days` and `0.50` are the same cell in five tables and no two of
 * them line up. It needs no ruler to see, which is why it is a criterion 15
 * failure rather than a quibble: it reads as five tables that happen to be
 * stacked rather than one scorecard.
 *
 * The pack already solved this class once, on the matters table
 * (`packMattersColumns`): a `<colgroup>` of explicit percentages under
 * `table-layout: fixed`, computed from the same arithmetic the height model
 * uses. This is that, for page 9.
 *
 * THE WIDTHS ARE SIZED FROM THE WIDEST CONTENT, NOT CHOSEN. Fixing a column
 * narrower than its longest unbreakable cell clips it, and the two columns at
 * risk are the ones that must never wrap: TARGET holds `+35.0%` / `30 days` /
 * `1.50`, and STATUS holds `NOT MEANINGFUL` at 8pt uppercase with letter
 * spacing. Both are measured here through the pack's own ruler, and
 * `packScorecardColumns.test.ts` fails if a longer token ever appears.
 *
 * ACTUAL and PRIOR are deliberately NOT sized to their longest content: they
 * carry not-meaningful REASONS — whole sentences — and `.pack-scorecard-row
 * td` sets `white-space: normal` precisely so those wrap. They take what is
 * left, split evenly, so the two figure columns are the same width as each
 * other on every block, which is the alignment the eye actually checks.
 */
import { PAGE_WIDTH_MM, PT_MM, textWidthEms, WIDTH_SAFETY } from './packTextMetrics';

/** The measure page 9's tables are set across — the full portrait text width,
 *  the same one `packMattersColumns` uses. */
export const SCORECARD_TABLE_MM = PAGE_WIDTH_MM.portrait;

/** The METRIC column, unchanged from the CSS rule it replaces: the metric
 *  name carries the most words in the row and 34% is what page 9 has always
 *  given it. */
const METRIC_SHARE = 0.34;

/** The TREND column, unchanged: `.pack-scorecard-trend` was 18mm. */
const TREND_MM = 18;

/** Cell padding either side, from `.pack-table td`. Charged so a column sized
 *  to its content is sized to the box that holds it. */
const CELL_PADDING_MM = 3;

/** The longest thing each never-wrapping column can hold.
 *
 *  TARGET: `formatTarget` renders money, a percentage, a ratio or a day count
 *  in the same unit as the actual it is a goal for, or the en dash for a
 *  metric with no target. `30 days` is the widest of the shapes page 9
 *  actually prints; `(1 234.5)%` is wider than anything a TARGET has been and
 *  is carried as headroom, because a target is a platform default and a new
 *  one must not silently clip.
 *  STATUS: `STATUS_LABEL` at its longest. */
const WIDEST_TARGET = '(1 234.5)%';
const WIDEST_STATUS = 'NOT MEANINGFUL';

/** Millimetres a string of `pt` text occupies on one line, through the pack's
 *  own ruler and its safety factor — the same arithmetic `wrappedLines`
 *  divides by, so a column this says fits is a column the height model agrees
 *  fits. */
export function singleLineMm(text: string, pt: number): number {
  return textWidthEms(text) * pt * PT_MM * WIDTH_SAFETY;
}

export interface ScorecardColumnsMm {
  metric: number;
  actual: number;
  target: number;
  prior: number;
  /** Null where the page draws no Trend column — see `showsTrend`. */
  trend: number | null;
  status: number;
}

/**
 * The five (or six) column widths, in print order.
 *
 * @param showsTrend Whether the page draws a Trend column at all. It is
 *   dropped where no series supports one, and the width it would have taken
 *   goes back to ACTUAL and PRIOR rather than to whichever column the
 *   browser felt like.
 */
export function scorecardColumnsMm(showsTrend: boolean): ScorecardColumnsMm {
  const metric = SCORECARD_TABLE_MM * METRIC_SHARE;
  const trend = showsTrend ? TREND_MM : null;
  // Sized to content, plus the padding of the cell that holds it. The header
  // words are shorter than these at the same size, so the body decides.
  const target = singleLineMm(WIDEST_TARGET, 9) + CELL_PADDING_MM * 2;
  const status = singleLineMm(WIDEST_STATUS, 8) + CELL_PADDING_MM * 2;
  // What is left, split evenly between the two figure columns that may wrap.
  const rest = SCORECARD_TABLE_MM - metric - target - status - (trend ?? 0);
  // AND IT FAILS RATHER THAN EMITTING A NEGATIVE COLUMN. A wider
  // `WIDEST_TARGET` or `WIDEST_STATUS` — both are constants, so this is a
  // static condition every pack would hit at once — would put a negative
  // percentage in the `<colgroup>` and the browser would silently redistribute
  // the table, which is the exact failure this module was written to stop.
  if (rest <= 0) {
    throw new Error(
      `scorecardColumnsMm: the fixed columns take ${(SCORECARD_TABLE_MM - rest).toFixed(2)}mm of a `
      + `${SCORECARD_TABLE_MM}mm table, leaving nothing for ACTUAL and PRIOR`,
    );
  }
  const half = rest / 2;
  return { metric, actual: half, target, prior: half, trend, status };
}

/** The same widths as the percentages a `<colgroup>` states, in print order.
 *  Percentages rather than millimetres for the same reason the matters table
 *  states them that way: the table is set across a measure the page owns, and
 *  a percentage cannot disagree with it. */
export function scorecardColumnPercents(showsTrend: boolean): string[] {
  const { metric, actual, target, prior, trend, status } = scorecardColumnsMm(showsTrend);
  const pct = (mm: number): string => `${((mm / SCORECARD_TABLE_MM) * 100).toFixed(3)}%`;
  return [
    pct(metric), pct(actual), pct(target), pct(prior),
    ...(trend === null ? [] : [pct(trend)]),
    pct(status),
  ];
}
