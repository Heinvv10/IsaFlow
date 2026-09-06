/**
 * Statement figure formatting. One place, so a number looks the same on the
 * screen, in the pack and in the PDF. Conventions: thousands separated by a
 * narrow space (en-ZA), negatives in parentheses, zero as an en dash.
 */
const ZERO_DASH = '–';
const MINUS = '−';

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
 * `numberConvention.scale`; omitting it is exactly today's behaviour, which
 * is why every existing caller outside the pack is byte-identical.
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

const whole = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function signOf(n: number): 'pos' | 'neg' | 'zero' {
  // A non-finite figure has no sign to speak of. Without this it fell through
  // to 'pos' and the statement printed "NaN" or "+NaN%" in a money column.
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return 'zero';
  return n < 0 ? 'neg' : 'pos';
}

export function formatMoney(
  n: number,
  opts: { cents?: boolean; symbol?: boolean; scale?: MoneyScale } = {},
): string {
  // Scaled BEFORE the sign is read, so the sign and the zero test both apply
  // to the number actually printed. A figure smaller than half a unit of its
  // scale prints `0` (rounds to nothing at this scale); an actual zero still
  // prints the dash, so the two stay distinguishable.
  const scaled = opts.scale ? n / MONEY_SCALES[opts.scale] : n;
  const s = signOf(scaled);
  if (s === 'zero') return ZERO_DASH;
  const body = (opts.cents ? cents : whole)
    .format(Math.abs(scaled))
    .replace(/[\xa0\u202f]/g, ' ')
    .replace(/,/g, '.');
  const withSymbol = opts.symbol ? `R ${body}` : body;
  return s === 'neg' ? `(${withSymbol})` : withSymbol;
}

export function formatPct(n: number, dp = 1): string {
  // A dash, not "0.0%": a percentage that could not be computed must not read
  // as a percentage of zero.
  if (!Number.isFinite(n)) return ZERO_DASH;
  const s = signOf(n);
  const body = `${Math.abs(n).toFixed(dp)}%`;
  if (s === 'zero') return `0.${'0'.repeat(dp)}%`;
  return s === 'neg' ? `${MINUS}${body}` : `+${body}`;
}

/**
 * `formatPct` without the leading sign, for prose that already carries
 * direction in a word ("up 12.0%", not "up +12.0%"). Same rounding
 * convention as `formatPct` (1dp by default) so a caption and the table
 * beside it never disagree on precision for the same underlying change —
 * that mismatch is what spec §7.1 criterion 8's one-number-convention rule
 * exists to stop. Callers must not strip the sign off `formatPct`'s own
 * output themselves; that would be a second, undeclared formatter.
 */
export function formatPctMagnitude(n: number, dp = 1): string {
  if (!Number.isFinite(n)) return ZERO_DASH;
  return `${Math.abs(n).toFixed(dp)}%`;
}
