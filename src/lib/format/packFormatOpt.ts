// Moved out of `money.ts` whole, for the 300-line limit; `money.ts`
// re-exports it, so every existing import path still resolves.

/**
 * THE BOARD PACK'S CONVENTIONS ARE OPT-IN, NOT SHARED.
 *
 * `formatStatementFigure` and `formatPct` serve statement screens, KPI tiles, chart
 * tooltips and the management-accounts page as well as the pack. The pack's
 * non-breaking separator, bracketed negative percentage and `<1` bound were
 * first written into the shared path, which changed every one of those
 * screens. They are now taken only by a caller that asks: `pack: true`, or —
 * for money — a `scale`, which only the pack passes. Everything else prints
 * exactly what it printed before the pack: ASCII space, U+2212 minus, `0`.
 * `formatRatio`, `formatDays` and `formatPctLevel` are pack-only formatters
 * with no earlier behaviour, so they take no option.
 */
export interface PackFormatOpt {
  pack?: boolean;
}
