/**
 * The one on-screen ZAR format: "R 25 000.00". Negative amounts render as "-R 2 300.00".
 *
 * Every space in it, the one after the R included, is a NON-BREAKING space: a line can never break between
 * the symbol and the figure (a bank-transactions row at 390 px wrapped "R" / "150.00"). Thousands are grouped with a NON-BREAKING space and the decimal is a dot, so a figure never
 * wraps across lines and never carries a comma that could be read as a decimal comma (SimplePay
 * read "25,000.00" as R25). This is also the shape `parseSaAmount` accepts back, so a displayed
 * amount round-trips. `Intl` is not used: en-ZA's separators differ across ICU builds, and the
 * page-local `Intl.NumberFormat('en-ZA', { style: 'currency' })` formatters this replaces printed
 * "R 25 000,00" (comma decimal) on some pages and "R 25 000.00" on others.
 *
 * Rounding is half away from zero on the decimal string, so 1.005 (stored by a double as
 * 1.00499999...) prints R 1.01, as a ledger would round it.
 */

interface FormatMoneyOptions {
  /** Decimal places (default 2). */
  decimals?: number;
}

const GROUP = '\u00A0';

/** abs rounded half away from zero to `decimals` places, as a fixed-point string. */
function toFixedHalfUp(abs: number, decimals: number): string {
  const text = String(abs);
  // Exponent notation (1e-7, 1e21) cannot be shifted by string concatenation; toFixed is exact enough there.
  if (!Number.isFinite(abs) || text.includes('e')) return abs.toFixed(decimals);
  return Number(`${Math.round(Number(`${text}e${decimals}`))}e-${decimals}`).toFixed(decimals);
}

interface Parts {
  negative: boolean;
  body: string;
}

function parts(amount: number, decimals: number): Parts {
  const fixed = toFixedHalfUp(Math.abs(amount), decimals); // e.g. "318400.00" (or "1200000" when decimals: 0)
  // "-R 0.00" is never printed: a sign only goes on a figure that survives rounding.
  const negative = amount < 0 && Number(fixed) !== 0;
  const [intPart = '', fracPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
  // Gate on fracPart, not decimals: toFixed() on NaN/Infinity yields no '.', so this keeps "R NaN" clean (no ".undefined").
  return { negative, body: fracPart !== undefined ? `${grouped}.${fracPart}` : grouped };
}

/** "R 25 000.00" / "-R 2 300.00". Non-finite inputs (NaN/Infinity) are the caller's responsibility; they pass through verbatim. */
export function formatMoney(amount: number, options: FormatMoneyOptions = {}): string {
  const { negative, body } = parts(amount, options.decimals ?? 2);
  return `${negative ? '-' : ''}R${GROUP}${body}`;
}

/** The same figure without the symbol, for a column whose header says it is rand: "25 000.00" / "-2 300.00". */
export function formatAmount(amount: number, options: FormatMoneyOptions = {}): string {
  const { negative, body } = parts(amount, options.decimals ?? 2);
  return `${negative ? '-' : ''}${body}`;
}

/**
 * Tile form: "R 5.5M", "-R 895.0K", and below R 1 000 the full figure ("R 172.50"). The sign leads the
 * symbol, as in formatMoney; the page-local copies this replaces printed "R -5.5M".
 */
export function formatMoneyCompact(amount: number, options: FormatMoneyOptions = {}): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${amount < 0 ? '-' : ''}R${GROUP}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${amount < 0 ? '-' : ''}R${GROUP}${(abs / 1_000).toFixed(1)}K`;
  return formatMoney(amount, options);
}

/**
 * An exchange rate: four to six decimals, no more than the rate carries ("18.3330", "0.054321"),
 * thousands grouped as in formatAmount. A rate is a ratio, not a rand amount, so it is not rounded to cents.
 */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return String(rate);
  const trimmed = rate.toFixed(6).replace(/(\.\d{4}\d*?)0+$/, '$1');
  const [int = '', frac = ''] = trimmed.split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP)}.${frac}`;
}

interface FormatCentsOptions {
  /** false drops the "R" prefix: "25 000.00" (field text that parses back to the same cents). */
  symbol?: boolean;
}

/**
 * The same text as `formatMoney(cents / 100)`, built from the INTEGER digits instead of dividing in floating
 * point, so the shown figure is exactly the stored cents (typed amounts, MoneyField echo, <Money cents>).
 * A non-integer or unsafe input has no exact digits: it falls back to `formatMoney` (garbage in, same as there).
 */
export function formatCents(cents: number, options: FormatCentsOptions = {}): string {
  if (!Number.isSafeInteger(cents)) return formatMoney(cents / 100);
  const digits = String(Math.abs(cents)).padStart(3, '0');
  const grouped = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
  return `${cents < 0 ? '-' : ''}${options.symbol === false ? '' : `R${GROUP}`}${grouped}.${digits.slice(-2)}`;
}
