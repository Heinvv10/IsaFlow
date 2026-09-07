/**
 * A KV item, as text. One implementation, read by the screen, the printed PDF
 * and the PowerPoint deck — the unit lives on the item, not in a renderer's
 * guess about the field name, and three renderers formatting a nullable ratio
 * their own way is how one of them ends up printing "0.00".
 *
 * Lives in the service layer rather than in PackSectionView so the PPTX route
 * can reuse it without pulling React and ECharts into an API bundle.
 */
import { formatDays, formatMoney, formatPct, formatRatio } from '@/lib/format/money';
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';
import type { PackKvItem } from './packDocument';

/** The en dash formatMoney prints for a zero, reused for a figure that has no
 *  value at all. Never "0.00": a ratio that could not be computed must not
 *  read as a ratio of zero. */
export const NO_FIGURE = '–';

export function formatPackKv(item: PackKvItem): string {
  // Whatever the format, an unavailable figure prints its reason INSTEAD of a
  // number, exactly as KpiTile.unavailable does on the executive dashboard.
  if (item.unavailable) return item.unavailable;
  if (item.value === null) return NO_FIGURE;
  switch (item.format) {
    case 'pct': return formatPct(item.value);
    case 'ratio': return formatRatio(item.value);
    case 'days': return formatDays(item.value);
    case 'money': return formatMoney(item.value, { cents: true });
  }
}

/**
 * A scorecard tile's figure, decided ONCE for all three surfaces.
 *
 * `KPIScorecardItem.value` is `number | null` — null whenever the engine could
 * not compute the ratio, which is the normal state for an insolvent company
 * (AN-07: every equity-divided ratio is meaningless, and coercing them to 0
 * scored one of them green). The deck handled that; the screen and the print
 * page each wrote their own tile, and the screen's called `.toFixed(2)` on the
 * null and took the whole page to the error boundary the moment a reader
 * expanded "KPI Scorecard" on Brightsphere.
 *
 * The decision is returned as a shape rather than a string because the two
 * React surfaces style the value and the target differently; the deck wants
 * one string and gets it from `formatScorecardValue` below. Both are built
 * here, so a fourth surface cannot invent a fourth answer.
 */
export type ScorecardFigure =
  | { scored: false; reason: string }
  | { scored: true; value: string; target: number };

export function scorecardFigure(item: KPIScorecardItem): ScorecardFigure {
  // The service's own reason, printed INSTEAD of a figure — the same rule
  // `formatPackKv` applies to an unavailable KV item, and the same string the
  // executive dashboard's KpiTile shows for the same ratio.
  if (item.value === null) return { scored: false, reason: item.reason ?? NO_FIGURE };
  return { scored: true, value: formatRatio(item.value), target: item.target };
}

/** The same decision as one line of text, for the deck. */
export function formatScorecardValue(item: KPIScorecardItem): string {
  const figure = scorecardFigure(item);
  return figure.scored ? `${figure.value} / ${figure.target}` : figure.reason;
}
