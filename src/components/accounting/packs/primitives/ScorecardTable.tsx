/**
 * Spec §4.A page 9 — the KPI scorecard. Six fixed columns (Metric, Actual,
 * Target, Prior, Trend, Status), rows grouped under a lettered heading
 * ("A. Profitability").
 *
 * `trend`/`trendSvg` are rendered as the model states them — never derived
 * from `actual` vs `prior` here. A `notMeaningful` row's actual cell prints
 * an en dash and a footnote MARKER only: the explanatory sentence itself
 * lives once, at the page foot (built from the page's own `footnotes`,
 * outside this component) — rubric criterion 9 fails a pack that repeats it
 * in every affected cell.
 */
import { formatFigureText } from './packFigureText';
import { collectReasons, NotMeaningfulCell, NotMeaningfulNotes } from './notMeaningfulNotes';
import type { MoneyScale } from '@/lib/format/money';
import { FootnoteMarker } from './FootnoteMarker';
import { scorecardColumnPercents } from '@/modules/accounting/services/packs/pages/packScorecardColumns';
import { formatDays, formatMoney, formatPct, formatRatio } from '@/lib/format/money';
import type {
  PackFigureFormat,
} from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type {
  PackScorecardGroup,
  PackScorecardRow,
  PackScorecardStatus,
  PackTrendDirection,
} from '@/modules/accounting/services/packs/pages/packPageModel';

/** Spec §4.A page 9: at most 5 rows in a group, at most 20 rows in the whole
 *  table. The total is checked FIRST — a single group blowing past the
 *  total cap should read as a total-cap failure, not a per-group one. */
const MAX_ROWS_PER_GROUP = 5;
const MAX_ROWS_TOTAL = 20;

const STATUS_LABEL: Record<PackScorecardStatus, string> = {
  met: 'Met',
  missed: 'Missed',
  notMeaningful: 'Not meaningful',
  unscored: 'Unscored',
};

/** Same three marks as the KPI tile's delta, and for the same reason — see
 *  `DELTA_GLYPH` in `KpiTileWithSparkline.tsx`. */
const TREND_GLYPH: Record<PackTrendDirection, string> = { up: '↑', down: '↓', flat: '→' };

function assertRowCaps(groups: PackScorecardGroup[]): void {
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  if (total > MAX_ROWS_TOTAL) {
    throw new Error(
      `ScorecardTable: ${total} rows across all groups exceeds the spec §4.A ` +
        `page 9 cap of ${MAX_ROWS_TOTAL}.`,
    );
  }
  for (const group of groups) {
    if (group.rows.length > MAX_ROWS_PER_GROUP) {
      throw new Error(
        `ScorecardTable: group '${group.letter}. ${group.name}' has ` +
          `${group.rows.length} rows, more than the ${MAX_ROWS_PER_GROUP}-row cap.`,
      );
    }
  }
}

/** `target` is a raw number, not a `PackFigure` (§ packPageModel), so it has
 *  no `format` of its own — it prints in the SAME unit as `actual`, the
 *  figure it is a goal for. */
function formatTarget(target: number | null, format: PackFigureFormat, scale: MoneyScale): string {
  if (target === null) return '–';
  switch (format) {
    // Scaled with the actual it is a goal for: a target printed in rands
    // beside an actual printed in thousands is the same 1000x contradiction,
    // in the one column a reader uses to judge whether the actual passed.
    case 'money': return formatMoney(target, { scale });
    case 'pct': return formatPct(target);
    case 'ratio': return formatRatio(target);
    case 'days': return formatDays(target);
  }
}

function ScorecardRowView({ row, scale, reasons, showsTrend }: {
  row: PackScorecardRow;
  scale: MoneyScale;
  reasons: string[];
  /** Whether the scorecard prints a Trend column at all — see the caller. */
  showsTrend: boolean;
}) {
  return (
    <tr className="pack-scorecard-row">
      <td>
        {row.metric}
        <FootnoteMarker number={row.footnote ?? null} />
      </td>
      {/* Rubric criterion 9: a not-meaningful cell never prints its reason in
       *  the cell. It prints `n/m` and the mark of the note that carries the
       *  reason in full, once, under the scorecard — see
       *  `notMeaningfulNotes`. The PRIOR column was the exception and nobody
       *  noticed: `formatFigureText` returns `unavailable` for a null figure,
       *  so on a company with no positive comparative base every ratio row
       *  carried the whole sentence and the page ran onto a second sheet. */}
      <td>{row.actual.value === null
        ? <NotMeaningfulCell figure={row.actual} reasons={reasons} />
        : formatFigureText(row.actual, scale)}</td>
      <td>{formatTarget(row.target, row.actual.format, scale)}</td>
      <td>{row.prior === undefined || row.prior === null
        ? null
        : row.prior.value === null
          ? <NotMeaningfulCell figure={row.prior} reasons={reasons} />
          : formatFigureText(row.prior, scale)}</td>
      {showsTrend && <td className="pack-scorecard-trend">
        {row.bulletSvg ? (
          <span
            className="pack-scorecard-trend-svg"
            dangerouslySetInnerHTML={{ __html: row.bulletSvg }}
          />
        ) : row.trendSvg ? (
          <span
            className="pack-scorecard-trend-svg"
            dangerouslySetInnerHTML={{ __html: row.trendSvg }}
          />
        ) : row.trend ? (
          TREND_GLYPH[row.trend]
        ) : null}
      </td>}
      <td className={`pack-scorecard-status is-${row.status}`}>{STATUS_LABEL[row.status]}</td>
    </tr>
  );
}

export interface ScorecardTableProps {
  groups: PackScorecardGroup[];
  /** The document's `numberConvention.scale` — see `formatFigureText`. */
  scale: MoneyScale;
  /** The page footnote the PRIOR heading points at — see the block model.
   *  Marked on EVERY group, because every group prints the heading: pages 6,
   *  7 and 8 mark their one, and one marker on the first of five leaves four
   *  bare headings claiming a comparative period nothing on the sheet dates. */
  priorFootnote?: number | null;
}

export function ScorecardTable({ groups, scale, priorFootnote = null }: ScorecardTableProps) {
  assertRowCaps(groups);

  // One note list for the WHOLE scorecard rather than one per group: the same
  // reason ("Revenue is not positive…") disqualifies metrics in several
  // groups at once, and three copies of it under three tables is the
  // repetition this mechanism exists to remove.
  const rows = groups.flatMap((group) => group.rows);
  const reasons = collectReasons(rows.flatMap((row) => [row.actual, row.prior]));

  // The TREND column is dropped when no row can fill it — the same
  // data-driven rule `ComparativeTable` applies to its own columns. R-P43
  // says no per-metric monthly series reaches the scorecard, so on today's
  // pack every cell is empty and the printed page carried a headed column of
  // nothing. A blank column reads as data that failed to load rather than as
  // a series the pack does not have.
  const showsTrend = rows.some((row) => row.trend !== null || row.trendSvg !== null || row.bulletSvg !== null);

  return (
    <div className="pack-scorecard">
      {groups.map((group) => (
        <table key={group.letter} className="pack-table pack-scorecard-group">
          <caption className="pack-scorecard-heading">{`${group.letter}. ${group.name}`}</caption>
          {/* ONE GRID ACROSS ALL FIVE BLOCKS.
            * Each lettered group is its own `<table>`, so `table-layout: auto`
            * sized every one of them from its own content: TARGET moved about
            * 10mm between blocks and PRIOR about 14mm, non-monotonically —
            * `+35.0%`, `1.50`, `30 days` and `0.50` are the same cell five
            * times and no two lined up. Pinning the first column at 34% in CSS
            * did not help and the comment there claiming it did was wrong: two
            * fixed columns still leave the rest distributed by content.
            *
            * Same fix as the matters table, from the same kind of arithmetic —
            * see `packScorecardColumns`, which sizes TARGET and STATUS to the
            * widest thing they can hold so a fixed column cannot clip one. */}
          <colgroup>
            {scorecardColumnPercents(showsTrend).map((width, i) => (
              <col key={width + String(i)} style={{ width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Actual</th>
              <th>Target</th>
              <th>Prior<FootnoteMarker number={priorFootnote} /></th>
              {showsTrend && <th>Trend</th>}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row, index) => (
              <ScorecardRowView
                key={`${row.metric}-${index}`}
                row={row}
                scale={scale}
                reasons={reasons}
                showsTrend={showsTrend}
              />
            ))}
          </tbody>
        </table>
      ))}
      <NotMeaningfulNotes reasons={reasons} />
    </div>
  );
}
