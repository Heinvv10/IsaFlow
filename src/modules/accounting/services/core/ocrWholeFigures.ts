/**
 * Numbers a document prints WITHOUT cents, and what marks one as money.
 *
 * ONE reader for all three rules of the whitelist: every whole number on
 * every line, with what its own text says about it. It does not decide that a
 * number is money — the roles that do (a payment, a change, a summary line)
 * and the one list that says a number is NOT money (a counter's label) belong
 * to `ocrPrintedFigures`.
 *
 * Round 18 dropped a number followed by any word before it got a role, so
 * `Paid 253 by card`, `CARD 253 APPROVED` and `EFT 1500 received` were never
 * read, and neither was `Call-out fee 350 (after hours)` on an unpaid
 * invoice. A trailing word no longer drops anything: the LABEL decides.
 *
 * Skipped here, each by its SHAPE: a date or a time (a neighbouring `:`, `/`,
 * `-` or `.` between digits); a leading zero (a slip or till number); a rate
 * (`%`); `N of M`; a number introduced by the word "number" itself (`No`,
 * `Nr`, `#`); masked card digits (`**** 1234`); seven or more digits (a VAT,
 * account or registration number); a reference code (`TAL-998877`); a street
 * number (`12 Main Road`); a unit glued to the digits (`2L`, `700G`);
 * and a UNIT word after it (`30 days`, `12 km`, `23 pp`). The unit words are a
 * closed list and it fails closed: a unit missing from it leaves the number
 * read, unlabelled, and the document refuses.
 */
import { parseAmount } from './ocrAmountParsing';

/** A whole number found on a line, before any role is given to it. */
export interface WholeToken {
  value: number;
  index: number;
  end: number;
  /** An `R`/`ZAR` in front, or `ZAR`, `,-`, `.-`, `=` or a dash after it. */
  moneyMark: boolean;
}

const WHOLE = /(?<![A-Za-z\d.,])((?:R|ZAR)\s?:?\s?)?(\d{1,3}(?:[ \u00A0.,]\d{3})+(?!\d)|\d+)(?![\d])(?![.,]\d)/g;

const MONEY_SUFFIX = /^\s*(?:ZAR(?![A-Za-z])|,-|\.-|=|-(?!\d))/i;
const NUMBER_WORD = /(?:#|(?<![A-Za-z])(?:No|Nr|Number)\.?)\s*:?\s*$/i;
const STREET = /^\s+(?:[A-Z][A-Za-z]+\s+){1,3}(?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Lane|Ln|Crescent|Cres|Close|Way|Boulevard|Blvd|Weg|Straat|Laan|Rylaan)(?![A-Za-z])/;
const UNIT_WORD = /^\s*(?:days?|dae|nights?|weeks?|months?|years?|jaar|hrs?|hours?|uur|mins?|minutes?|km|kms|m|cm|mm|kg|kgs|g|gram|grams|l|lt|litres?|liters?|ml|pp|pax|pcs|pieces?|units?|items?|x)(?![A-Za-z])/i;

/**
 * Every whole number on `line`. `centsSpans` are the cents figures already
 * read on it, blanked first so their digits are never read twice.
 */
export function wholeTokens(line: string, centsSpans: ReadonlyArray<readonly [number, number]>): WholeToken[] {
  let blanked = line;
  for (const [from, to] of centsSpans) {
    blanked = blanked.slice(0, from) + ' '.repeat(to - from) + blanked.slice(to);
  }
  const tokens: WholeToken[] = [];
  for (const match of blanked.matchAll(WHOLE)) {
    const prefix = match[1];
    const digits = match[2]!;
    const start = match.index + (prefix?.length ?? 0);
    const end = match.index + match[0].length;
    const before = blanked.slice(0, start);
    const after = blanked.slice(end);
    if (/^0\d/.test(digits)) continue;
    if (!prefix && /\d\s?[:/.-]$/.test(before)) continue;
    if (/^[:/.-]\d/.test(after) || /^\s*%/.test(after)) continue;
    if (/^\s*of\s+\d/i.test(after) || /(?<![A-Za-z])of\s+$/i.test(before)) continue;
    if (!prefix && NUMBER_WORD.test(before)) continue;
    // Masked card digits (`************1234`, `**** 1234`) are a card number.
    if (!prefix && /[*xX]{2,}[ \t]*$/.test(before)) continue;
    // A reference code: short capitals, then a dash or slash (`TAL-998877`).
    if (!prefix && /(?<![A-Za-z])[A-Z]{1,4}[-/]$/.test(before)) continue;
    // A street number (`12 Main Road`). A road word missing here leaves the
    // number read and the document refused, which is the safe direction.
    if (!prefix && STREET.test(after)) continue;
    const moneySuffix = MONEY_SUFFIX.test(after);
    if (!prefix && !moneySuffix && (/^[A-Za-z]/.test(after) || UNIT_WORD.test(after))) continue;
    const moneyMark = Boolean(prefix) || moneySuffix;
    const bare = digits.replace(/[ \u00A0.,]/g, '');
    // Seven or more digits is a VAT, account or registration number whatever
    // labels it — `VAT-4123456789` sits on a line that opens with `VAT`.
    if (bare.length >= 7 && !moneyMark) continue;
    tokens.push({ value: parseAmount(bare), index: start, end, moneyMark });
  }
  return tokens;
}
