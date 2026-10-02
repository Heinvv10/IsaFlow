/**
 * Statement figure formatting. One place, so a number looks the same on the
 * screen, in the pack and in the PDF. Conventions: thousands separated by a
 * space (en-ZA), negative money in brackets, zero as an en dash. The BOARD
 * PACK's stricter forms — a NON-BREAKING space, bracketed percentages, `<1` —
 * are opt-in (`pack: true`, or a money `scale`); see `PackFormatOpt`. Screens
 * print what they printed before the pack.
 *
 * ONE NEGATIVE CONVENTION, FOR EVERY KIND OF NUMBER IN THE PACK (spec §7.1 criterion 8).
 * A rendered board pack printed `(1 546)` for money, `−1348.0%` for a
 * percentage and `-0.14` for a ratio — three markers for one idea, the
 * second a U+2212 and the third an ASCII hyphen, all three within a few rows
 * of each other on one sheet. A reader who has to learn which marker a
 * column uses is being asked to do the document's work.
 *
 * The bracket wins because it is the convention a financial statement is
 * read in and the one `formatMoney` has always used; `formatPct` and
 * `formatRatio` were the outliers and now follow it, in the pack. There is no
 * minus sign in the pack's output: the sign character a reader sees is `(`
 * and `)`, and nothing else. PROSE is the one exception, and it is not an exception to
 * the convention so much as to the notion of a figure position — a sentence
 * carries its direction in a WORD, through `pctWithWord` below, because
 * "margin is (12.0%)" reads as an aside rather than as a negative.
 */
import { MONEY_SCALES, type MoneyScale } from './moneyScale';

export { inScale, MONEY_SCALES, toMoneyScale } from './moneyScale';
export type { MoneyScale } from './moneyScale';
import type { PackFormatOpt } from './packFormatOpt';
export type { PackFormatOpt } from './packFormatOpt';

const ZERO_DASH = '–';
const MINUS = '−';

/**
 * A FORMATTED FIGURE, MOVED INTO A SENTENCE.
 *
 * Every formatter here prints a measured zero — and a percentage that cannot
 * be computed — as an en dash, which is the right glyph in a money COLUMN
 * where the reader is scanning for the ones that carry a value. In prose it
 * is not a glyph at all: a rendered board pack carried three panel titles
 * reading "Revenue rose from – to – over 12 periods", asserting a rise with
 * a dash where each figure belongs, on a page going to directors.
 *
 * So a sentence says the word. One helper rather than a `prose` option on
 * each formatter, because the rule is about the POSITION the figure lands in
 * rather than about its unit, and an option is what the next caller forgets.
 */
export function inProse(formatted: string): string {
  return formatted === ZERO_DASH ? 'nil' : formatted;
}

/**
 * THE THOUSANDS SEPARATOR IS A SPACE THAT CANNOT BREAK.
 *
 * `Intl` gives en-ZA a narrow no-break space (U+202F), and every formatter
 * here replaced it with an ASCII space — chosen so one glyph would render
 * identically in the browser, in Chromium's PDF and in a test fixture. An
 * ASCII space is a LINE-BREAK OPPORTUNITY, so a figure in prose can split
 * across two lines at its own separator: the eleventh visual gate found
 * `4 128` set as "4" at the end of one line and "128" at the start of the
 * next, inside Brightsphere's governance table, and read it as the defect a
 * CFO would see first.
 *
 * It is DATA-DEPENDENT — it happens wherever the wrap lands, so no fixture
 * and no single render proves its absence — which is why the fix is the
 * separator and not the sentence. U+00A0 rather than U+202F: both are
 * non-breaking, and U+00A0 is present in every font this pack can be set in,
 * while U+202F is missing from many and renders as a notdef box or as
 * nothing at all. A separator that silently disappears would turn `4 128`
 * into `4128`, which is a worse failure than the one being fixed.
 *
 * Every reader of a formatted figure that splits or compares it must
 * normalise U+00A0 as well as ASCII space — see `packTextLayer.ts` and the
 * scale tests, which already did.
 */
export const GROUP_SEPARATOR = '\u00a0';

/** Whatever separator `Intl` produced, as THIS module's one separator. */
function separated(formatted: string): string {
  return formatted.replace(/[\x20\xa0\u202f]/g, GROUP_SEPARATOR).replace(/,/g, '.');
}

/**
 * A magnitude to `dp` places with its integer part grouped like money.
 * `toFixed` prints `1310.8` beside rand figures that read `1 310`; in the
 * pack every four-digit figure carries the one separator, whatever its unit.
 * Pack path only — screens keep what they printed.
 */
const fixedPlain = (magnitude: number, dp: number): string => magnitude.toFixed(dp);

function groupedFixed(magnitude: number, dp: number): string {
  const [int = '', frac] = magnitude.toFixed(dp).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEPARATOR);
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

/** What every screen printed before the board pack existed: an ASCII space. */
function separatedLegacy(formatted: string): string {
  return formatted.replace(/[\xa0\u202f]/g, ' ').replace(/,/g, '.');
}

const whole = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function signOf(n: number): 'pos' | 'neg' | 'zero' {
  // A non-finite figure has no sign to speak of. Without this it fell through
  // to 'pos' and the statement printed "NaN" or "+NaN%" in a money column.
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return 'zero';
  return n < 0 ? 'neg' : 'pos';
}

/**
 * WHETHER THE BRACKET IS EARNED — the figure is below zero AND still says so
 * at the precision it is printed to.
 *
 * The bracket is this document's ONE negative convention, and three of the
 * four formatters tested `n < 0` directly while `formatPct` routed its zero
 * through `signOf`. So a level of −0.001% printed `(0.0%)`, a ratio of
 * −0.0001 printed `(0.00)` and −0.4 days printed `(0 days)`: a bracketed
 * zero, which reads to a director as a negative figure that rounded away and
 * to nobody as the nothing it is. `signOf`'s half-cent tolerance does not
 * settle it either — it is a fixed threshold and these carry a `dp`.
 *
 * The test is therefore the PRINTED body, not the measured one: a figure
 * whose digits are all zeros at this precision is not shown as negative.
 * `signOf` still decides the en dash on the money path, where a measured zero
 * is a different statement from a small one.
 */
function bracketed(n: number, dp: number): boolean {
  return n < 0 && Number(Math.abs(n).toFixed(dp)) !== 0;
}

/**
 * A REAL FIGURE TOO SMALL FOR ITS PRECISION, STATED AS A BOUND.
 *
 * Velocity Fibre's cash ratio of 0.0034 printed as nil on a board pack — the
 * two-place figure is `0.00`, and a reader takes `0.00×` and the dash alike
 * as "no cash". `formatMoney` already states an amount below its scale as
 * `<1`; a ratio, a day count and a percentage level now say the same thing
 * in their own unit: `<0.01`, `<1 day`, `<0.1%`, bracketed where negative.
 * A measured zero is not below its precision and keeps its zero.
 *
 * Null where the figure prints as itself.
 */
function belowPrecision(n: number, dp: number, unit: string): string | null {
  if (n === 0 || Number(Math.abs(n).toFixed(dp)) !== 0) return null;
  const bound = `<${dp === 0 ? '1' : `0.${'0'.repeat(dp - 1)}1`}${unit}`;
  return n < 0 ? `(${bound})` : bound;
}

/** A figure too small to survive its scale, printed as a bound rather than as
 *  a zero — see `formatMoney`. */
const BELOW_SCALE = '<1';

export function formatMoney(
  n: number,
  opts: { cents?: boolean; symbol?: boolean; scale?: MoneyScale } & PackFormatOpt = {},
): string {
  const pack = opts.pack === true || opts.scale !== undefined;
  const scaled = opts.scale ? n / MONEY_SCALES[opts.scale] : n;
  // The tolerance is half a cent on the amount measured: float residue off a
  // subtraction reads as the measured zero it is. It is on `n`, not on the
  // number printed — at `R'000` every amount under R5 is under half a printed
  // unit, and the dash, this formatter's word for a measured zero, must not be
  // printed over real money.
  const s = signOf(n);
  if (s === 'zero') return ZERO_DASH;
  const body = (pack ? separated : separatedLegacy)((opts.cents ? cents : whole).format(Math.abs(scaled)));
  // PACK ONLY: a real amount that rounds to nothing at this scale is not `0`.
  //
  // The board pack's matters page listed journals for board decision with a
  // quantum column reading `0` under an `R'000` header: R400 of exposure,
  // printed as the digit a reader takes to mean "no money involved". `<1`
  // says what is true: there is an amount, and it is under one unit of the
  // scale stated in the header. Screens keep `0`, as they always printed.
  //
  // Only on the whole-number path: `cents` already prints `0.40`, which is
  // both non-zero and exact.
  if (pack && !opts.cents && body === '0') {
    const withSymbolBelow = opts.symbol ? `R ${BELOW_SCALE}` : BELOW_SCALE;
    return s === 'neg' ? `(${withSymbolBelow})` : withSymbolBelow;
  }
  const withSymbol = opts.symbol ? `R ${body}` : body;
  return s === 'neg' ? `(${withSymbol})` : withSymbol;
}

export function formatPct(n: number, dp = 1, opt: PackFormatOpt = {}): string {
  // A dash, not "0.0%": a percentage that could not be computed must not read
  // as a percentage of zero.
  if (!Number.isFinite(n)) return ZERO_DASH;
  const s = signOf(n);
  const body = `${(opt.pack ? groupedFixed : fixedPlain)(Math.abs(n), dp)}%`;
  if (s === 'zero') return opt.pack ? `${(0).toFixed(dp)}%` : `0.${'0'.repeat(dp)}%`;
  if (!opt.pack) return s === 'neg' ? `${MINUS}${body}` : `+${body}`;
  // `signOf`'s threshold is half a cent and this carries a `dp`, so a change
  // of −0.006 cleared it and printed `(0.0%)` at one decimal — a bracketed
  // zero on a document whose negative convention IS the bracket.
  if (s === 'neg' && !bracketed(n, dp)) return `${(0).toFixed(dp)}%`;
  // Brackets, not U+2212, in the pack. See the module docblock: one negative
  // convention. The leading `+` on a positive stays — it marks a change
  // column's direction, and a bracket and a plus are the same convention read
  // in two directions, not two conventions.
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
  const bound = belowPrecision(n, dp, '%');
  if (bound !== null) return bound;
  const body = `${groupedFixed(Math.abs(n), dp)}%`;
  // Not `n < 0`: a level of −0.001% is `0.0%` at one decimal, and a bracketed
  // zero is a negative figure to a reader. See `bracketed`.
  return bracketed(n, dp) ? `(${body})` : body;
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
  const bound = belowPrecision(n, dp, '');
  if (bound !== null) return bound;
  const body = groupedFixed(Math.abs(n), dp);
  // Not `signOf`: a ratio of 0.00 is a MEASURED ratio, and the en dash is
  // this module's word for a figure that is not there at all. Only the sign
  // is decided here — and only where the printed digits still carry it, so
  // −0.0001 is `0.00` rather than `(0.00)`.
  return bracketed(n, dp) ? `(${body})` : body;
}

/** A multiple — "1.50×", "(0.14)×": `formatRatio`, the × outside the bracket.
 *  The board pack's unit for every ratio it prints, as `ratioPresentation`'s
 *  'times' is everywhere else. */
export function formatTimes(n: number, dp = 2): string {
  return Number.isFinite(n) ? `${formatRatio(n, dp)}×` : ZERO_DASH;
}

/**
 * A day count — debtor days, creditor days — in the same convention.
 *
 * SEPARATED LIKE EVERY OTHER FOUR-DIGIT FIGURE IN THE PACK. `toFixed` emits
 * `1035`, and the scorecard printed `1035 days` two rows under `1 546` and
 * `3 355`: one document, two ways of writing a thousand, and the one that
 * broke the rule was the one carrying a unit. The separator comes from the
 * same `en-ZA` formatter the money path uses, so a thousand is a thousand
 * wherever it prints.
 */
export function formatDays(n: number, dp = 0): string {
  if (!Number.isFinite(n)) return ZERO_DASH;
  const bound = belowPrecision(n, dp, ' day');
  if (bound !== null) return bound;
  const digits = separated(new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  }).format(Math.abs(n)));
  const body = `${digits} days`;
  // −0.4 days is `0 days`, not `(0 days)` — see `bracketed`.
  return bracketed(n, dp) ? `(${body})` : body;
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
  return `${groupedFixed(Math.abs(n), dp)}%`;
}

export function pctWithWord(n: number, up: string, down: string, nil?: string, dp = 1): ProsePct {
  // A non-finite percentage has no magnitude to state and no direction to
  // name. The dash is the same answer `formatPct` gives, and the direction
  // word is dropped with it — "up –" would be worse than either.
  if (!Number.isFinite(n)) return ZERO_DASH as ProsePct;
  // A FIGURE THAT ROUNDS TO NOTHING HAS NO DIRECTION: "a positive 0.0%" and
  // "a negative 0.0%" name a sign the printed digits do not carry. Decided on
  // the ROUNDED figure. Only where the sentence supplies its nil words — what
  // reads right ("nil", "unchanged", "at nil") depends on the sentence, so a
  // caller that names none keeps its old output.
  if (nil !== undefined && Number(Math.abs(n).toFixed(dp)) === 0) return nil as ProsePct;
  // Zero counts as the positive word, matching every call site's previous
  // `pct >= 0 ? 'up' : 'down'`.
  return `${n < 0 ? down : up} ${formatPctMagnitude(n, dp)}` as ProsePct;
}
