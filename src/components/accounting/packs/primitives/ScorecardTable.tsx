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
import { FootnoteMarker } from './FootnoteMarker';
import { formatMoney, formatPct } from '@/lib/format/money';
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

const TREND_GLYPH: Record<PackTrendDirection, string> = { up: '▲', down: '▼', flat: '■' };

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
function formatTarget(target: number | null, format: PackFigureFormat): string {
  if (target === null) return '–';
  switch (format) {
    case 'money': return formatMoney(target);
    case 'pct': return formatPct(target);
    case 'ratio': return target.toFixed(2);
    case 'days': return `${target.toFixed(0)} days`;
  }
}

function ScorecardRowView({ row }: { row: PackScorecardRow }) {
  return (
    <tr className="pack-scorecard-row">
      <td>
        {row.metric}
        <FootnoteMarker number={row.footnote ?? null} />
      </td>
      {/* Rubric criterion 9: a not-meaningful row's Actual cell prints an en
       *  dash, not `actual.unavailable` — that reason is stated ONCE, in the
       *  page-foot footnote the marker above points to, never repeated here. */}
      <td>{row.actual.value === null ? '–' : formatFigureText(row.actual)}</td>
      <td>{formatTarget(row.target, row.actual.format)}</td>
      <td>{row.prior ? formatFigureText(row.prior) : null}</td>
      <td className="pack-scorecard-trend">
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
      </td>
      <td className={`pack-scorecard-status is-${row.status}`}>{STATUS_LABEL[row.status]}</td>
    </tr>
  );
}

export interface ScorecardTableProps {
  groups: PackScorecardGroup[];
}

export function ScorecardTable({ groups }: ScorecardTableProps) {
  assertRowCaps(groups);

  return (
    <div className="pack-scorecard">
      {groups.map((group) => (
        <table key={group.letter} className="pack-table pack-scorecard-group">
          <caption className="pack-scorecard-heading">{`${group.letter}. ${group.name}`}</caption>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Actual</th>
              <th>Target</th>
              <th>Prior</th>
              <th>Trend</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row, index) => (
              <ScorecardRowView key={`${row.metric}-${index}`} row={row} />
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}
