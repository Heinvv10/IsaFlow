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
import { formatDays, formatMoney, formatPct, formatRatio, signOf, type MoneyScale } from '@/lib/format/money';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';

/** The pack's one glyph for a figure measured and nil — page 12 defines it,
 *  and `formatMoney` already returns it. Stated here so a percentage, a ratio
 *  and a day count of nil print the SAME character rather than each unit's
 *  own idea of zero. */
const ZERO_FIGURE = '\u2013';

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
  // ONE GLYPH FOR A MEASURED NIL, WHATEVER UNIT IT IS MEASURED IN.
  //
  // `formatMoney` prints the en dash for a figure measured and nil — which is
  // what page 12 defines it as — and `formatPct` prints "0.0%". So the demo
  // pack's page-6 "Other expenses" row printed a dash under Actual, Prior and
  // Change and `0.0%` under % of Revenue: four measured zeros on one line,
  // rendered two ways, with nothing in the basis distinguishing them.
  //
  // A nil share of a positive base IS a measured nil, so it takes the pack's
  // word for one. This does NOT collapse the other case: a share of a base
  // that is not positive has no value at all, and arrives here as a null
  // figure with its own stated reason (`REVENUE_NOT_A_POSITIVE_BASE`) — which
  // is why Brightsphere's cell prints `n/m` and must go on doing so. Nil
  // numerator and unusable denominator are two different facts and the pack
  // says both; what it may not do is say "nil" two ways on one row.
  //
  // Here rather than in `formatPct`, which is the whole codebase's percentage
  // formatter and serves screens where a zero per cent is read as a number
  // rather than as an accounting nil. This function is the board pack's one
  // figure-to-text, so the convention lands exactly on the document that
  // declares it.
  if (signOf(figure.value) === 'zero' && figure.format !== 'money') return ZERO_FIGURE;
  switch (figure.format) {
    case 'money': return formatMoney(figure.value, { scale });
    case 'pct': return formatPct(figure.value);
    case 'ratio': return formatRatio(figure.value);
    case 'days': return formatDays(figure.value);
  }
}
