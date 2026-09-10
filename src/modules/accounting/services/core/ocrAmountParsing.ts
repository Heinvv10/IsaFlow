/**
 * How a printed AMOUNT is read as a number.
 *
 * Split from `ocrAmountPatterns` so that file stays inside the 300-line cap.
 * The division is the same one that file already makes: this module knows how
 * a figure is spelled, `ocrAmountPatterns` knows how a LABEL is spelled, and
 * neither knows what a document is.
 *
 * Two defects shaped it:
 *
 *   - The decimal comma. South Africa prints "R1 150,00". Stripping commas
 *     with the thousands spaces turned that into 115000.
 *   - The VAT label. A letterhead "VAT 4123456789" read a registration number
 *     as an amount; `isPlausibleVatAmount` is the arithmetic that refuses it.
 */

/**
 * A printed amount, in either convention.
 *
 * The grouped alternative admits a space, non-breaking space, comma or point as
 * a THOUSANDS separator only where three digits follow it, and at most two
 * digits as the decimal part. Being that strict is the point: the earlier class
 * `[\d\s,]*` was greedy over `\s`, which includes a NEWLINE, so a capture
 * starting at the total ran on and swallowed the next figure on the document.
 *
 * The `+` on the thousands group is load-bearing. With `*` the grouped
 * alternative matched "115" out of "1150.00" — three digits, no groups, no
 * decimal — and alternation takes the first branch that matches at all, so
 * every plain amount was truncated to its first three digits.
 *
 * The trailing `(?![\d.,]*\d)` refuses to HALF-READ a malformed figure. An OCR
 * artefact "1150.000" used to match "1150.00" and abandon the last digit, and
 * the same shape reads "1150.005" as 1150.00 — a wrong number with no warning.
 * A plain `(?!\d)` is not enough: the engine simply backtracks to "1150" and
 * matches that instead. Requiring that NO digit follows through a run of digits
 * and separators makes the whole match fail, so the field comes back null and
 * the caller's own validation refuses the document.
 *
 * The leading `-?` is the SIGN, and it is inside the capture group so
 * `parseAmount` sees it. Without it a credit note printing "Sub Total -100.00 /
 * VAT -15.00 / Total -115.00" came back {100, 15, 115} with no warning — a
 * refund read as a purchase, balanced, and inside the auto-post gate. It only
 * ever reaches this pattern when the hyphen is glued to the first digit; the
 * label separators in `ocrAmountPatterns` consume a spaced dash themselves.
 */
export const AMOUNT = String.raw`(-?(?:\d{1,3}(?:[ \u00A0.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?))(?![\d.,]*\d)`;

/**
 * Read a printed amount as a number.
 *
 * The separator is decided by the LAST one in the string: followed by one or
 * two digits to the end it is the decimal point, and anything else is a
 * thousands separator. That one rule covers "1 150,00", "1,234.56", "1.234,56"
 * and "1,234" without a per-locale switch, and it is why the replacement is not
 * `.replace(',', '.')` — that call is non-global, so "1,234,56" had only its
 * FIRST comma converted and parsed as 1.23.
 */
export function parseAmount(str: string): number {
  const compact = str.replace(/[\s\u00A0]/g, '');
  const decimal = /[.,](\d{1,2})$/.exec(compact);
  const cleaned = decimal
    ? `${compact.slice(0, decimal.index).replace(/[.,]/g, '')}.${decimal[1]}`
    : compact.replace(/[.,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

/** Does the printed form carry a decimal part? A registration number never does. */
function hasDecimalPart(raw: string): boolean {
  return /[.,]\d{1,2}$/.test(raw.replace(/[\s\u00A0]/g, ''));
}

/**
 * Is this VAT candidate an amount rather than a registration number?
 *
 * A VALUE test, not a shape test. Counting digits (`^\d{9,10}$`) failed on one
 * OCR digit too many or too few: "VAT: 41234567" sailed through and drove the
 * derived subtotal to minus forty-one million. What actually separates the two
 * is arithmetic — the tax on a document can never exceed the document's own
 * total, and a registration number always does.
 *
 * The comparison is on MAGNITUDE because a credit note prints both figures
 * negative: `-15 <= -115` is false, so a signed VAT line printed without cents
 * would be refused as a registration number and the tax lost entirely.
 */
export function isPlausibleVatAmount(raw: string, totalAmount: number | null): boolean {
  if (hasDecimalPart(raw)) return true;
  const value = Math.abs(parseAmount(raw));
  return totalAmount !== null ? value <= Math.abs(totalAmount) : value < 1_000_000;
}
