/**
 * A KV item, as text. One implementation, read by the screen, the printed PDF
 * and the PowerPoint deck — the unit lives on the item, not in a renderer's
 * guess about the field name, and three renderers formatting a nullable ratio
 * their own way is how one of them ends up printing "0.00".
 *
 * Lives in the service layer rather than in PackSectionView so the PPTX route
 * can reuse it without pulling React and ECharts into an API bundle.
 */
import { formatMoney, formatPct } from '@/lib/format/money';
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
    case 'ratio': return item.value.toFixed(2);
    case 'days': return `${item.value.toFixed(0)} days`;
    case 'money': return formatMoney(item.value, { cents: true });
  }
}
