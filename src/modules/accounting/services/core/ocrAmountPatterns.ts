/**
 * The amount grammar the OCR regex fallback reads invoices and till slips with.
 *
 * Split out of `ocrExtractionService` so that file stays inside the 300-line
 * cap, and because every rule here is about how a NUMBER or a LABEL is printed
 * — nothing in this module knows what a document is.
 *
 * Three defects shaped it, and each one is a rule below rather than a comment:
 *
 *   - The decimal comma. South Africa prints "R1 150,00". Stripping commas
 *     with the thousands spaces turned that into 115000.
 *   - The label boundary. `Total` with nothing to its left matched the `total`
 *     inside `Subtotal`, `Sub Total` and `Sub-Total`, and `String.match`
 *     returns the FIRST hit — so the VAT-exclusive figure became the total.
 *   - The VAT label. Every separator was optional, so a letterhead
 *     "VAT 4123456789" read a registration number as an amount.
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
 */
const AMOUNT = String.raw`(\d{1,3}(?:[ \u00A0.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;

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
 */
export function isPlausibleVatAmount(raw: string, totalAmount: number | null): boolean {
  if (hasDecimalPart(raw)) return true;
  const value = parseAmount(raw);
  return totalAmount !== null ? value <= totalAmount : value < 1_000_000;
}

/**
 * The payable total.
 *
 * `(?<![A-Za-z])` rejects a letter immediately before the label, which covers
 * the joined "Subtotal". `(?<!Sub[-\s])` is the other half and is NOT
 * redundant: in "Sub Total" and "Sub-Total" the character before the label is a
 * space or a hyphen, so the first lookbehind lets them through. The file's own
 * subtotal patterns already spell both, which is how the codebase knows they
 * occur.
 */
export const TOTAL_PATTERNS: RegExp[] = [
  new RegExp(String.raw`(?<![A-Za-z])(?<!Sub[-\s])(?:Grand\s*)?Total\s*(?:Due|Amount|Payable)?\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'i'),
  new RegExp(String.raw`(?<![A-Za-z])(?:Amount|Balance)\s*(?:Due|Owing|Payable)\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'i'),
  new RegExp(String.raw`(?<![A-Za-z])(?<!Sub[-\s])Total\s*(?:Incl(?:uding)?\.?\s*(?:VAT|Tax))?\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'i'),
];

/**
 * The VAT amount, most specific label first.
 *
 * The bare column form is LAST and is not optional: a till slip prints
 * "VAT      0.00" with nothing but whitespace between, and dropping it does not
 * merely lose the figure — `buildExpenseJournalFromReceipt` derives 15% of the
 * total whenever `vatAmount` is null, so a document stating the VAT is ZERO
 * (zero-rated foodstuffs, routine in SA retail) produced an invented input-tax
 * claim that the document itself denies.
 *
 * Its `(?![\d.,]*\s*%)` guard stops it reading the RATE off "VAT 15% 150.00",
 * which the rate form above handles when the `@` is printed and nothing handles
 * when it is not.
 */
export const VAT_PATTERNS: RegExp[] = [
  new RegExp(String.raw`VAT\s*(?:@|\()\s*\d+(?:[.,]\d+)?\s*%\s*\)?\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'gi'),
  new RegExp(String.raw`VAT\s*[:-]\s*(?:ZAR|R)?\s*${AMOUNT}`, 'gi'),
  new RegExp(String.raw`VAT\s+(?:ZAR|R)\s*${AMOUNT}`, 'gi'),
  new RegExp(String.raw`Tax\s*(?:Amount)?\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'gi'),
  new RegExp(String.raw`VAT\s+${AMOUNT}(?![\d.,]*\s*%)`, 'gi'),
];

export const SUBTOTAL_PATTERNS: RegExp[] = [
  new RegExp(String.raw`Sub\s*[-\s]?Total\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'i'),
  new RegExp(String.raw`Total\s*(?:Excl(?:uding)?\.?\s*(?:VAT|Tax))\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'i'),
  new RegExp(String.raw`Nett?\s*(?:Amount|Total)\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'i'),
];

/**
 * The VAT amount, from the first label form that yields a plausible candidate.
 *
 * Every occurrence of that form is collected, not just the first, for two
 * reasons. A registration number printed above the real VAT line used to
 * consume the whole pattern; and a slip that splits its VAT summary across
 * several lines used to report only the first, under-claiming.
 *
 * Summing is allowed ONLY where the arithmetic proves it: subtotal + sum must
 * equal the stated total. Without that check a document printing both a
 * per-line VAT and a "Total VAT" of the same figure would double it, and the
 * result would still balance well enough to post.
 */
export function extractVatAmount(
  text: string,
  subtotal: number | null,
  totalAmount: number | null,
): number | null {
  for (const pattern of VAT_PATTERNS) {
    const candidates: number[] = [];
    for (const match of text.matchAll(pattern)) {
      if (match[1] && isPlausibleVatAmount(match[1], totalAmount)) {
        candidates.push(parseAmount(match[1]));
      }
    }
    if (candidates.length === 0) continue;

    if (candidates.length > 1 && subtotal !== null && totalAmount !== null) {
      const sum = Math.round(candidates.reduce((a, c) => a + c, 0) * 100) / 100;
      if (Math.round((subtotal + sum) * 100) / 100 === totalAmount) return sum;
    }
    return candidates[0]!;
  }
  return null;
}
