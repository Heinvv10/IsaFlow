/**
 * One place to turn a `PackFigure` into its printed text, read by every
 * primitive that renders one — the KPI tile and the comparative table both
 * call this rather than each switching on `figure.format` its own way, which
 * is exactly how this pack once ended up with four competing margin
 * definitions.
 *
 * `formatMoney`/`formatPct` (src/lib/format/money.ts) are the only money/pct
 * formatters in this codebase and are used as-is. `formatRatio`/`formatDays` are
 * theirs, added to that same module when a scorecard printed `-0.14` from a
 * bare `toFixed(2)` on a sheet whose money column read `(1 546)` — an ASCII
 * hyphen and an accounting bracket for the same idea, two rows apart.
 */
import { formatDays, formatMoney, formatPct, formatRatio, type MoneyScale } from '@/lib/format/money';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';

/**
 * @param scale The document's `numberConvention.scale`. Applies to money
 *   only — a percentage, a ratio and a day count are not stated in rands and
 *   so are not scaled.
 *
 * REQUIRED, deliberately. It was optional, and every one of the four
 * primitives then called this with no scale while `ComparativeTable` printed
 * "R'000" as its own caption directly above the cells — the unsafe path was
 * the default, so the first renderer wired for real would have reintroduced
 * the 1000x misread. A required argument makes forgetting it a compile
 * error instead of a silently wrong board pack.
 */
export function formatFigureText(figure: PackFigure, scale: MoneyScale): string {
  if (figure.value === null) {
    // `PackFigureProvenance.figure()` refuses to construct a null value
    // without a reason, so this is always populated in practice — the
    // fallback exists only so a malformed figure still prints something
    // instead of throwing mid-render on a board pack.
    return figure.unavailable ?? '–';
  }
  switch (figure.format) {
    case 'money': return formatMoney(figure.value, { scale });
    case 'pct': return formatPct(figure.value);
    case 'ratio': return formatRatio(figure.value);
    case 'days': return formatDays(figure.value);
  }
}
