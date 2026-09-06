/**
 * One place to turn a `PackFigure` into its printed text, read by every
 * primitive that renders one — the KPI tile and the comparative table both
 * call this rather than each switching on `figure.format` its own way, which
 * is exactly how this pack once ended up with four competing margin
 * definitions.
 *
 * `formatMoney`/`formatPct` (src/lib/format/money.ts) are the only money/pct
 * formatters in this codebase and are used as-is. `ratio`/`days` have no
 * dedicated formatter there yet, so they fall back to the same convention
 * already reviewed and shipped for the legacy pack KV items
 * (`src/modules/accounting/services/packs/packKvFormat.ts`) rather than
 * inventing a new one here.
 */
import { formatMoney, formatPct, type MoneyScale } from '@/lib/format/money';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';

/**
 * @param scale The document's `numberConvention.scale`. Applies to money
 *   only — a percentage, a ratio and a day count are not stated in rands and
 *   so are not scaled. Omitted, every figure prints exactly as before.
 */
export function formatFigureText(figure: PackFigure, scale?: MoneyScale): string {
  if (figure.value === null) {
    // `PackFigureProvenance.figure()` refuses to construct a null value
    // without a reason, so this is always populated in practice — the
    // fallback exists only so a malformed figure still prints something
    // instead of throwing mid-render on a board pack.
    return figure.unavailable ?? '–';
  }
  switch (figure.format) {
    case 'money': return formatMoney(figure.value, scale ? { scale } : {});
    case 'pct': return formatPct(figure.value);
    case 'ratio': return figure.value.toFixed(2);
    case 'days': return `${figure.value.toFixed(0)} days`;
  }
}
