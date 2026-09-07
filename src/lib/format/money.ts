/**
 * Statement figure formatting. One place, so a number looks the same on the
 * screen, in the pack and in the PDF. Conventions: thousands separated by a
 * narrow space (en-ZA), negatives in brackets, zero as an en dash.
 *
 * ONE NEGATIVE CONVENTION, FOR EVERY KIND OF NUMBER (spec §7.1 criterion 8).
 * A rendered board pack printed `(1 546)` for money, `−1348.0%` for a
 * percentage and `-0.14` for a ratio — three markers for one idea, the
 * second a U+2212 and the third an ASCII hyphen, all three within a few rows
 * of each other on one sheet. A reader who has to learn which marker a
 * column uses is being asked to do the document's work.
 *
 * The bracket wins because it is the convention a financial statement is
 * read in and the one `formatMoney` has always used; `formatPct` and
 * `formatRatio` were the outliers and now follow it. There is no minus sign
 * left in this module: the sign character a reader sees is `(` and `)`, and
 * nothing else. PROSE is the one exception, and it is not an exception to
 * the convention so much as to the notion of a figure position — a sentence
 * carries its direction in a WORD, through `pctWithWord` below, because
 * "margin is (12.0%)" reads as an aside rather than as a negative.
 */
const ZERO_DASH = '–';

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

/** A figure too small to survive its scale, printed as a bound rather than as
 *  a zero — see `formatMoney`. */
const BELOW_SCALE = '<1';

export function formatMoney(
  n: number,
  opts: { cents?: boolean; symbol?: boolean; scale?: MoneyScale } = {},
): string {
  // Scaled BEFORE the sign is read, so the sign and the zero test both apply
  // to the number actually printed. An actual zero prints the dash.
  const scaled = opts.scale ? n / MONEY_SCALES[opts.scale] : n;
  const s = signOf(scaled);
  if (s === 'zero') return ZERO_DASH;
  const body = (opts.cents ? cents : whole)
    .format(Math.abs(scaled))
    .replace(/[\xa0\u202f]/g, ' ')
    .replace(/,/g, '.');
  // A REAL amount that rounds to nothing at this scale is not `0`.
  //
  // The board pack's matters page listed journals for board decision with a
  // quantum column reading `0` under an `R'000` header: R400 of exposure,
  // printed as the digit a reader takes to mean "no money involved". It is the
  // mirror of the 1000x misread the scale mechanism exists to stop — one
  // direction prints thousands as rands, the other prints rands as nothing —
  // and `–` would be worse still, because the dash is this formatter's word
  // for a measured zero. `<1` says what is true: there is an amount, and it is
  // under one unit of the scale stated in the header.
  //
  // Only on the whole-number path: `cents` already prints `0.40`, which is
  // both non-zero and exact.
  if (!opts.cents && body === '0') {
    const withSymbolBelow = opts.symbol ? `R ${BELOW_SCALE}` : BELOW_SCALE;
    return s === 'neg' ? `(${withSymbolBelow})` : withSymbolBelow;
  }
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
  // Brackets, not U+2212. See the module docblock: one negative convention.
  // The leading `+` on a positive stays — it marks a change column's
  // direction, and a bracket and a plus are the same convention read in two
  // directions, not two conventions.
  return s === 'neg' ? `(${body})` : `+${body}`;
}

/**
 * A percentage stated as a LEVEL rather than as a change — a gross margin, a
 * share of revenue, a debtor concentration.
 *
 * `formatPct` prefixes `+` because it reads a change column, and "+12.3%"
 * over a gross-margin trend panel claims a movement that was never measured.
 * Same negative convention, no sign on the positive side. A separate function
 * rather than an option on `formatPct`: an option has a default, and the
 * default is what a caller forgets.
 */
export function formatPctLevel(n: number, dp = 1): string {
  if (!Number.isFinite(n)) return ZERO_DASH;
  const body = `${Math.abs(n).toFixed(dp)}%`;
  return n < 0 ? `(${body})` : body;
}

/**
 * A ratio — a current ratio, a gearing, a times-covered — at two decimals.
 *
 * Here rather than at the four call sites that each wrote `value.toFixed(2)`:
 * that is how `-0.14` reached a board pack's scorecard on the same sheet as
 * `(1 546)` and `−1348.0%`. `toFixed` emits an ASCII hyphen, which is not
 * this codebase's negative marker and is not the marker on the row above it.
 */
export function formatRatio(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return ZERO_DASH;
  const body = Math.abs(n).toFixed(dp);
  // Not `signOf`: a ratio of 0.00 is a MEASURED ratio, and the en dash is
  // this module's word for a figure that is not there at all. Only the sign
  // is decided here.
  return n < 0 ? `(${body})` : body;
}

/** A day count — debtor days, creditor days — in the same convention. */
export function formatDays(n: number, dp = 0): string {
  if (!Number.isFinite(n)) return ZERO_DASH;
  const body = `${Math.abs(n).toFixed(dp)} days`;
  return n < 0 ? `(${body})` : body;
}

/**
 * A percentage that has been PAIRED WITH ITS DIRECTION, and the only way to
 * obtain one for prose.
 *
 * `formatPctMagnitude` used to be exported for this and it was correct in
 * isolation and wrong in context: it prints an unsigned magnitude, on the
 * understanding that the sentence around it supplies the direction in a word
 * ("up 12.0%"). Two sentences were then written that supply no such word —
 * "Operating margin is 1564.3%." and "Gross margin of 1348.0% carried…" —
 * and a board pack's largest type reported a catastrophic negative margin as
 * a positive one, two centimetres above its own table reading the opposite.
 * That is not a formatting bug; it is a false statement about the business.
 *
 * The remedy is the shape `TrustedChartSvg` uses (`src/lib/charts/trustedChartSvg.ts`):
 * a branded value with exactly ONE guarded way to obtain it. The magnitude
 * formatter below is no longer exported, so a sentence cannot be handed a
 * bare percentage from this module at all — the next author of the next
 * sentence has to name the word that carries the sign, and forgetting is a
 * compile error (`formatPctMagnitude` does not resolve) rather than a wrong
 * number on paper.
 *
 * `up`/`down` are the words THIS sentence wants — "up"/"down" for a change,
 * "a positive"/"a negative" for a level, "at"/"at negative" where the
 * percentage is a cover ratio. Both are required: an empty positive word
 * reintroduces the undirected number this type exists to make unwritable.
 */
export type ProsePct = string & { readonly __prosePct: unique symbol };

/** The magnitude, deliberately NOT exported. See `ProsePct`. */
function formatPctMagnitude(n: number, dp = 1): string {
  return `${Math.abs(n).toFixed(dp)}%`;
}

export function pctWithWord(n: number, up: string, down: string, dp = 1): ProsePct {
  // A non-finite percentage has no magnitude to state and no direction to
  // name. The dash is the same answer `formatPct` gives, and the direction
  // word is dropped with it — "up –" would be worse than either.
  if (!Number.isFinite(n)) return ZERO_DASH as ProsePct;
  // Zero counts as the positive word, matching every call site's previous
  // `pct >= 0 ? 'up' : 'down'`.
  return `${n < 0 ? down : up} ${formatPctMagnitude(n, dp)}` as ProsePct;
}
