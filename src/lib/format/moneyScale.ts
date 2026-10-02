/**
 * The scales a statement may be stated in, and the one form prose states a
 * figure's scale in. Moved out of `money.ts` unchanged to keep that file
 * under the 300-line cap; `money.ts` re-exports every name here, so existing
 * import paths still resolve.
 */

/**
 * A FIGURE AND ITS UNIT, IN THE ONE FORM PROSE STATES THEM.
 *
 * `R'000` is a COLUMN BANNER everywhere a statement prints — set once above
 * the figures it governs, never beside one of them. Two sentences juxtaposed
 * the banner token against a number instead ("3 544 R'000 of exposure", "a
 * span of 3 529 R'000"), which put the unit in a third position: above the
 * column on nine sheets, trailing the figure on two. A reader who has to
 * work out where the unit is has to work out whether it applies.
 *
 * The pack already had a prose form and used it four times — "Figures in
 * R'000", "in R'000; one caveat qualifies these figures" — so this is that
 * form, with one owner. `packProseIntegrity` refuses a pack that prints the
 * bare juxtaposition, so a third form cannot be added by hand.
 */
export function inScale(formatted: string, scale: MoneyScale): string {
  return `${formatted}, in ${scale}`;
}

/**
 * The scales a statement may be stated in. `formatMoney` divides by the
 * scale's divisor before formatting, so "R'000" prints 4 200 000 as `4 200`
 * under a thousands header instead of the full rand amount, which a reader
 * takes as a thousand times the real figure.
 *
 * SCALING IS A DISPLAY CONCERN AND LIVES HERE (R-P52). Model figures stay
 * RAW — a page or a model that divided would put arithmetic where no service
 * owns it, and the integrity gate compares raw values, so a display
 * transform must never reach them. Callers pass the document's own
 * `numberConvention.scale`; omitting it (and `pack`) is exactly the
 * pre-pack behaviour, which is why every existing caller outside the pack is
 * byte-identical.
 */
export const MONEY_SCALES = {
  R: 1,
  "R'000": 1_000,
  "R'm": 1_000_000,
} as const;

export type MoneyScale = keyof typeof MONEY_SCALES;

/** The document's scale string, narrowed. `null` for anything unrecognised —
 *  a caller must decide what to do about that rather than silently printing
 *  unscaled figures under a scaled header, which is the 1000× misread this
 *  whole mechanism exists to stop. */
export function toMoneyScale(value: string): MoneyScale | null {
  return Object.prototype.hasOwnProperty.call(MONEY_SCALES, value) ? (value as MoneyScale) : null;
}
