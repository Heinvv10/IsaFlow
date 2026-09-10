/**
 * Numbers a document prints WITHOUT cents, and what marks one as money.
 *
 * Round 17 read a whole number in one place only — below the total block, on
 * a line with no cents figure, as the last thing on its line — and fed it to
 * one rule. The round-17 review beat every one of those restrictions: a
 * whole-rand PAYMENT (`Paid by card 253`, `EFT 1500`) was never summed, so it
 * was excused rather than refused; `SERVICE:23`, `23,-`, `23=`, `SERVICE 23
 * ZAR`, `Waiter 23 CASH` and a charge beside a cents figure were not read at
 * all. So there is now ONE reader, used by all three rules, that finds every
 * whole number on every line and records what its own text says about it.
 *
 * What it does NOT do is decide that a number is money. `Items 2`, `Table 12`,
 * `Pump 5` and `SERVICE 23` have the same shape, and no spelling separates
 * them. The roles that do — a payment, a change, a summary line — belong to
 * `ocrPrintedFigures`, which has those labels; the whitelist then treats a
 * number no role claims as a COUNT only where the payments have proven what
 * was paid (`ocrLargerFigure`, rule 3).
 *
 * Skipped here, each by its SHAPE rather than by a list of labels: a date or a
 * time (a neighbouring `:`, `/`, `-` or `.` between digits); a leading zero (a
 * slip or till number); a rate (`%`); `N of M`; a number introduced by the
 * word "number" itself (`No`, `Nr`, `#`); masked card digits (`**** 1234`);
 * seven or more digits (a VAT, account or registration number); and a number
 * followed by a word that
 * is not a payment or a currency — a unit or prose (`30 days`, `20L`, `23 pp`,
 * `350 (after hours)`). A rate annotation after an amount (`23 (10%)`) is kept.
 */
import { parseAmount } from './ocrAmountParsing';

/** A whole number found on a line, before any role is given to it. */
export interface WholeToken {
  value: number;
  index: number;
  end: number;
  /** An `R`/`ZAR` in front, or `ZAR`, `,-`, `.-`, `=` or a dash after it. */
  moneyMark: boolean;
  /** Four to six bare digits with no mark: a reference unless a role claims it. */
  identifier: boolean;
}

const WHOLE = /(?<![A-Za-z\d.,])((?:R|ZAR)\s?:?\s?)?(\d{1,3}(?:[ \u00A0.,]\d{3})+(?!\d)|\d+)(?![\d])(?![.,]\d)/g;

const MONEY_SUFFIX = /^\s*(?:ZAR(?![A-Za-z])|,-|\.-|=|-(?!\d))/i;
const RATE_NOTE = /^\s*\(\s*\d+(?:[.,]\d+)?\s*%\s*\)/;
const LINE_END = /^[\s*)\]]*$/;
const NUMBER_WORD = /(?:#|(?<![A-Za-z])(?:No|Nr|Number)\.?)\s*:?\s*$/i;

/**
 * Every whole number on `line`. `centsSpans` are the cents figures already
 * read on it, blanked first so their digits are never read twice.
 * `startsPayment` says whether a payment word opens the text after a number,
 * which is the one trailing word that keeps it (`Waiter 23 CASH`).
 */
export function wholeTokens(
  line: string,
  centsSpans: ReadonlyArray<readonly [number, number]>,
  startsPayment: (after: string) => boolean,
): WholeToken[] {
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
    const moneySuffix = MONEY_SUFFIX.test(after);
    if (!LINE_END.test(after) && !moneySuffix && !RATE_NOTE.test(after) && !startsPayment(after)) continue;
    const moneyMark = Boolean(prefix) || moneySuffix;
    const bare = digits.replace(/[ \u00A0.,]/g, '');
    // Seven or more digits is a VAT, account or registration number whatever
    // labels it — `VAT-4123456789` sits on a line that opens with `VAT`.
    if (bare.length >= 7 && !moneyMark) continue;
    tokens.push({
      value: parseAmount(bare),
      index: start,
      end,
      moneyMark,
      identifier: !moneyMark && bare.length >= 4 && bare === digits,
    });
  }
  return tokens;
}
