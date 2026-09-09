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
 *
 * The trailing `(?![\d.,]*\d)` refuses to HALF-READ a malformed figure. An OCR
 * artefact "1150.000" used to match "1150.00" and abandon the last digit, and
 * the same shape reads "1150.005" as 1150.00 — a wrong number with no warning.
 * A plain `(?!\d)` is not enough: the engine simply backtracks to "1150" and
 * matches that instead. Requiring that NO digit follows through a run of digits
 * and separators makes the whole match fail, so the field comes back null and
 * the caller's own validation refuses the document.
 */
const AMOUNT = String.raw`(\d{1,3}(?:[ \u00A0.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d.,]*\d)`;

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
 * Not the `Total` inside a subtotal label.
 *
 * `(?<![A-Za-z])` rejects a letter immediately before the label, which covers
 * the joined "Subtotal". The second lookbehind is the other half, and its
 * QUANTIFIER is the whole point. Written `(?<!Sub[-\s])` it was fixed-width-one
 * — it rejected "Sub Total" and "Sub-Total" and let through "Sub  Total",
 * "SUB   TOTAL" and every OCR column that prints the label with more than one
 * space. That is not a rare spelling: this file's OWN subtotal grammar below is
 * `Sub\s*[-\s]?\s*Total`, so the module already asserts the separator varies,
 * and the guard has to cover the shape the module admits. `[\s-]*` is
 * variable-length, which JavaScript lookbehind (unlike most engines) supports,
 * and its `*` also subsumes the joined "SubTotal".
 *
 * What it cost when it did not hold: "Sub  Total 1000.00\nTotal 1150.00" read
 * the total as 1000. With no VAT line the builder derives 1000/1.15, so the
 * entry BALANCES at the wrong figure, clears the callers' pre-check, passes the
 * auto-post gate and posts unattended — expense short by R150 and a bank credit
 * that can never match the R1 150 the statement shows.
 */
const NOT_A_SUBTOTAL = String.raw`(?<![A-Za-z])(?<!Sub[\s-]*)`;

/**
 * Not the `VAT`/`Tax` inside a TOTAL label.
 *
 * "Total Excluding VAT 1 000.00" and "Total Including VAT 1 150.00" are the
 * ordinary SA invoice spelling, and both put the bare word VAT in front of an
 * amount that is not the tax. Without this the first was read as VAT = the
 * subtotal, which unbalances the journal and refuses an entirely well-formed
 * invoice. Same variable-length lookbehind as above, and for the same reason:
 * the separator between the word and VAT is whatever the printer used.
 */
const NOT_A_TOTAL_LABEL = String.raw`(?<!(?:Ex|In)cl(?:uding)?\.?[\s-]*)`;

/** The payable total. */
export const TOTAL_PATTERNS: RegExp[] = [
  new RegExp(String.raw`${NOT_A_SUBTOTAL}(?:Grand\s*)?Total\s*(?:Due|Amount|Payable)?\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'i'),
  new RegExp(String.raw`(?<![A-Za-z])(?:Amount|Balance)\s*(?:Due|Owing|Payable)\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'i'),
  new RegExp(String.raw`${NOT_A_SUBTOTAL}Total\s*(?:Incl(?:uding)?\.?\s*(?:VAT|Tax))?\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'i'),
];

/**
 * The VAT amount, most specific label first.
 *
 * The bare column form is not optional: a till slip prints "VAT      0.00" with
 * nothing but whitespace between, and dropping it does not merely lose the
 * figure — `buildExpenseJournalFromReceipt` derives 15% of the total whenever
 * `vatAmount` is null, so a document stating the VAT is ZERO (zero-rated
 * foodstuffs, routine in SA retail) produced an invented input-tax claim that
 * the document itself denies.
 *
 * Its `(?![\d.,]*\s*%)` guard stops it reading the RATE off "VAT 15% 150.00",
 * which the rate form above handles when the `@` is printed and nothing handles
 * when it is not.
 *
 * The generic `Tax` form is LAST, BELOW the bare VAT column, and the order is
 * load-bearing rather than stylistic. `extractVatAmount` takes the first
 * pattern that yields any candidate at all, so while `Tax` ranked above the
 * bare form, any non-VAT tax or levy line — routine on the hotel and airline
 * bills `MERCHANT_PATTERNS` explicitly routes — outranked the real VAT line:
 * "Tourism Levy Tax 12.00 / VAT 150.00" extracted 12.00, and with the subtotal
 * derived as total − 12 the entry still BALANCED and auto-posted, R138 of input
 * tax unclaimed and the VAT201 input box short by the same.
 */
export const VAT_PATTERNS: RegExp[] = [
  new RegExp(String.raw`${NOT_A_TOTAL_LABEL}VAT\s*(?:@|\()\s*\d+(?:[.,]\d+)?\s*%\s*\)?\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'gi'),
  new RegExp(String.raw`${NOT_A_TOTAL_LABEL}VAT\s*[:-]\s*(?:ZAR|R)?\s*${AMOUNT}`, 'gi'),
  new RegExp(String.raw`${NOT_A_TOTAL_LABEL}VAT\s+(?:ZAR|R)\s*${AMOUNT}`, 'gi'),
  new RegExp(String.raw`${NOT_A_TOTAL_LABEL}VAT\s+${AMOUNT}(?![\d.,]*\s*%)`, 'gi'),
  new RegExp(String.raw`${NOT_A_TOTAL_LABEL}Tax\s*(?:Amount)?\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'gi'),
];

/**
 * The VAT-exclusive subtotal.
 *
 * `Sub[\s-]*Total` is deliberately the SAME grammar as `NOT_A_SUBTOTAL` above.
 * While the two disagreed, "Sub - Total 1000.00" was correctly refused as the
 * payable total and then not recognised as the subtotal either, so the figure
 * was simply lost. A label the file knows enough to reject has to be a label
 * the file knows enough to read.
 */
export const SUBTOTAL_PATTERNS: RegExp[] = [
  new RegExp(String.raw`Sub[\s-]*Total\s*[:-]?\s*(?:ZAR|R)?\s*${AMOUNT}`, 'i'),
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
      // Prefer the candidate the DOCUMENT'S OWN ARITHMETIC endorses over the
      // one that happens to be printed first. Where a slip prints both a levy
      // and the VAT under the same label form, subtotal + candidate === total
      // picks the tax out of the pair; falling through to `candidates[0]` picks
      // by page order, which is not evidence of anything.
      const reconciling = candidates.filter(
        (c) => Math.round((subtotal + c) * 100) / 100 === totalAmount,
      );
      if (reconciling.length === 1) return reconciling[0]!;

      const sum = Math.round(candidates.reduce((a, c) => a + c, 0) * 100) / 100;
      if (Math.round((subtotal + sum) * 100) / 100 === totalAmount) return sum;
    }
    return candidates[0]!;
  }
  return null;
}
