/**
 * Does the document's TEXT say it is a credit, a refund or a return?
 *
 * Every posting path the unattended gate serves books a PURCHASE, so a
 * document that returns money posts the entry backwards. `detectDocumentType`
 * knows only `CREDIT NOTE`, and the amount grammar reads a trailing minus
 * (`TOTAL 499.00-`) as positive, so `REFUND / Kettle 499.00- / TOTAL 499.00-`,
 * `RETURN SLIP / … / REFUNDED TO CARD 499.00` and `KREDIETNOTA / … / Totaal
 * 115.00` each posted, or auto-approved, as a purchase.
 *
 * Each indicator is anchored to a position where it can only describe the
 * DOCUMENT, never an item on it — `Credit card surcharge 5.00` and `VISA
 * CREDIT 253.00` are ordinary purchases:
 *   - a document-type header on a line of its own (`NO REFUND WITHOUT SLIP`
 *     is a footer, not a header);
 *   - a refund word on a line that carries a money figure (`CARD REFUND
 *     115.00`, `Refund Total 499.00`);
 *   - the total itself printed with a sign the grammar does not read: a
 *     trailing minus, a glued minus or parentheses, on a figure of its size.
 */

import { parseAmount } from './ocrAmountParsing';

const CREDIT_HEADER = /^[\s*=-]*(?:TAX\s+)?(?:CREDIT(?:\s+NOTE)?|KREDIETNOTA|REFUND(?:\s+(?:SLIP|RECEIPT))?|RETURNS?(?:\s+SLIP)?|TERUGBETALING)[\s*=-]*$/im;

const REFUND_WITH_FIGURE = /(?<![A-Za-z])(?:REFUND(?:ED)?|TERUGBETAL\w*)(?![A-Za-z])[^\n]*?\d[.,]\d{2}/i;

/** A money figure; what is printed immediately around it carries the sign. */
const FIGURE = /(?<![\d.,])(\d{1,3}(?:[ \u00A0.,]\d{3})+[.,]\d{2}|\d+[.,]\d{2})(?![\d.,]*\d)/g;

/**
 * Is a figure of the total's size printed negative — a trailing minus, a
 * minus glued to it, or parentheses? A SPACED dash (`Total - 115.00`) is a
 * label separator, as `VALUE_SEP` reads it, and is not a sign.
 */
function totalPrintedSigned(text: string, total: number): boolean {
  const size = Math.abs(total);
  for (const match of text.matchAll(FIGURE)) {
    if (parseAmount(match[1]!) !== size) continue;
    const before = text.slice(Math.max(0, match.index - 6), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 3);
    if (/^-(?!\d)/.test(after) || /[-–](?:R|ZAR)?$/.test(before)) return true;
    if (/\(\s*(?:R|ZAR)?\s*$/.test(before) && /^\s*\)/.test(after)) return true;
  }
  return false;
}

export function hasCreditIndicator(text: string, total: number | null | undefined): boolean {
  if (CREDIT_HEADER.test(text) || REFUND_WITH_FIGURE.test(text)) return true;
  return total !== null && total !== undefined && total !== 0 && totalPrintedSigned(text, total);
}
