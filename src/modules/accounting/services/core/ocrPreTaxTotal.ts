/**
 * Is the total read a PRE-TAX figure (K-072 round 29)?
 *
 * Round 28's arithmetic (`vat ≤ total × 15/115`) cannot see a pre-tax total
 * when part of the net is zero-rated or a no-VAT disbursement: `Consulting
 * 800.00 / CIPC fee (no VAT) 200.00 / Total (excl. VAT) 1000.00 / VAT 15%
 * 120.00`, with no grand total printed, posted R1 000 against R1 120. Two
 * structural rules, and both only REFUSE:
 *
 *  (a) the line that prints the total says it excludes the tax (`Total
 *      (excl. VAT)`, `Total 1000.00 excl VAT`, `before VAT`, `nett of VAT`)
 *      while the document prints a VAT: the payable is more;
 *  (b) on a document NO payment settles, a tax line printed BELOW the total
 *      (after its last print) is a tax ADDED to it — unless that line, or the
 *      total's own line, says the tax is included (`VAT INCL`, `Total Incl
 *      VAT`), the tax is already printed above the total (the recap of a tax
 *      the total contains), or the arithmetic proves it: the VAT is exactly
 *      the standard-rate tax inside the total (`Amount Due 147.40 / VAT
 *      19.23`), no item is marked zero-rated, exempt or no-VAT (round 30: with
 *      such an item an exact match is the coincidence a pre-tax total lands
 *      in), and the total's own line names it PAYABLE (round 32: a pre-tax
 *      `Total` within R0.38 of a no-VAT share lands on the exact match with
 *      no mark at all, and a supplier with a fixed fee pair lands on it on
 *      EVERY invoice — so a bare `Total` is not proof). A paid slip's recap
 *      under a total the tender settles is not judged: the payment proves the
 *      payable.
 */
import { totalPrintedLastEnd } from './ocrAmountReconciliation';
import { isTaxOnlyLine, printedFigures } from './ocrPrintedFigures';

/** The SA standard rate (`reports/vatBoxBasis.SA_VAT_RATE`, not imported: that module reaches the DB client). */
const SA_VAT_RATE = 0.15;

/**
 * Can this total CONTAIN this VAT? At 15% the tax inside an inclusive total T
 * is at most T × 15/115 — zero-rated lines only lower it. `Total (excl. VAT)
 * 1000.00 / VAT 15% 150.00` with no grand total printed reads 1 000 and 150:
 * 15% OF the total, so the total read is the pre-tax figure (round 28). The
 * 0.05 clears per-line rounding. Pure arithmetic, so it holds with no text.
 */
export function vatExceedsInclusiveTotal(vat: number | null | undefined, total: number | null | undefined): boolean {
  return vat != null && total != null && total > 0 && vat > (total * SA_VAT_RATE) / (1 + SA_VAT_RATE) + 0.05;
}

/** Does the VAT read equal the tax an inclusive total at the standard rate carries? */
function isInclusiveTax(vat: number, total: number): boolean {
  return Math.abs(vat - (total * SA_VAT_RATE) / (1 + SA_VAT_RATE)) <= 0.05;
}

const TAX = String.raw`(?:VAT|BTW|tax|belasting)`;
const PRE_TAX = new RegExp(String.raw`(?<![A-Za-z])(?:Exc(?:l\w*)?\.?|Exclusive|Ex[\s.-]*${TAX}|before\s+${TAX}|nett?\s+of\s+${TAX}|pre[\s-]?tax|w/o\s*${TAX}|without\s+${TAX}|Eks(?:\.|klusief\w*)?|sonder\s+${TAX})(?![A-Za-z])`, 'i');
/**
 * A line marked zero-rated, exempt or no-VAT. An inclusive total carrying such
 * a line holds LESS than total × 15/115 of tax, so a VAT exactly equal to that
 * proves nothing there — it is the coincidence a pre-tax total lands in.
 */
const NOT_STANDARD_RATED = new RegExp(String.raw`(?<![A-Za-z])(?:no[\s-]+${TAX}|non[\s-]*${TAX}|exempt\w*|zero[\s-]*rated|vrygestel\w*|disbursement\w*|geen\s+${TAX}|nul[\s-]*koers)(?![A-Za-z])|\(\s*Z\s*\)|(?<![\d.,])0(?:[.,]0+)?\s*%`, 'i');
/**
 * The token a LEGEND defines as that marker (round 32): `Z = zero rated`, `* =
 * zero-rated items`, `D = disbursement, no VAT`, `Items marked # are VAT
 * exempt`, `Vrygestelde items gemerk V`, `Prices include VAT unless marked Z`.
 * SA invoices print the bare token on the item and define it once, so the
 * legend is the only evidence the item is not standard-rated. Read per segment,
 * so `A = VAT 15%, B = Zero rated` defines B, not A; `(Z) Zero rated`, `Note:
 * Z zero rated`, `Items marked with an E are exempt` and `Items with a Z are
 * zero-rated` define theirs too.
 */
const TOKEN = String.raw`[A-Z*#†]`;
const LEGEND_TOKEN = new RegExp(String.raw`(?:^|:)\s*(?:\(\s*(${TOKEN})\s*\)|(${TOKEN})(?:\s*(?:[=:–-]|denotes|means|indicates)|\s))`
  + String.raw`|(?:[Mm]arked|[Gg]emerk|[Dd]enoted|[Ii]ndicated|[Ss]hown|[Ff]lagged|(?<=\w\s+)with)\s+(?:(?:with|by|as|met)\s+(?:an?\s+)?|an?\s+)?\(?(${TOKEN})\)?(?![A-Za-z\d])`);
const UNLESS_MARKED = /unless\s+marked/i;
const legendTokens = (text: string) => text.split(/\r?\n/).flatMap((line) => line.split(/[,;]|\s{2,}/))
  .filter((segment) => NOT_STANDARD_RATED.test(segment) || UNLESS_MARKED.test(segment))
  .map((segment) => LEGEND_TOKEN.exec(segment)).flatMap((m) => (m ? [m[1] ?? m[2] ?? m[3]!] : []));
/** The token standing alone on a line: a letter not inside a word, a symbol not inside a run. */
const standsAlone = (token: string, line: string) => (/[A-Z]/.test(token)
  ? new RegExp(String.raw`(?<![A-Za-z\d])${token}(?![A-Za-z\d])`) : new RegExp(String.raw`(?<![*#†])[${token}](?![*#†])`)).test(line);
/** A line that prints only an amount: the price column of a split layout. */
const FIGURE_ONLY = /^\s*(?:R\s*)?-?\d[\d ,]*[.,]\d{2}\s*$/;

/**
 * Is an ITEM above the total marked zero-rated, exempt or no-VAT? The marker
 * counts on an item: a line that prices something (round 31: a legend or
 * footer marks nothing on its own), or a description whose price the layout
 * split into a later figure-only line (round 32). A legend's token counts on
 * any such item that carries it alone (round 32).
 */
function marksAnItem(text: string, end: number): boolean {
  const above = text.slice(0, end).split(/\r?\n/);
  const tokens = legendTokens(text);
  return above.some((line, i) => {
    const item = printedFigures(line).length > 0 || above.slice(i + 1).some((later) => FIGURE_ONLY.test(later));
    if (!item) return false;
    return NOT_STANDARD_RATED.test(line) || (legendTokens(line).length === 0 && tokens.some((token) => standsAlone(token, line)));
  });
}

/**
 * A net label printed AFTER the total's figure (`Total 1000.00 Nett`, `…
 * Subtotal`, `… Taxable Amount`, `… uitgesluit BTW`): it names that figure a
 * net. Only trailing — `Nett Amount Due 1150.00` before the figure is payable.
 */
const NET_AFTER = /(?<![A-Za-z])(?:Nett?o?|Sub[\s-]*(?:Tota?a?l)?|Subtotaal|Goods\s+Value|Taxable|uitgesluit)(?![A-Za-z])/i;
const afterFigure = (line: string) => line.slice(line.search(/\d[^\d]*$/) + 1);
const INCLUDED = /(?<![A-Za-z])(?:Incl\w*|Inclusive|included|portion)(?![A-Za-z])/i;
/**
 * A label naming the figure the amount to PAY (`Amount Due`, `Bedrag
 * Verskuldig`): not a net. A bare `Total`/`Totaal` does not, and neither do
 * `Grand Total`/`Invoice Total` (round 33, measured: admitting them posts the
 * reviewer's `Invoice Total 1150.30 / VAT 150.00` fee pair at R1 150.30 against
 * R1 300.30 — they name the last figure printed, not what is owed).
 */
const PAYABLE = /(?<![A-Za-z])(?:(?:Amount|Balance|Total)\s+Due|(?:Amount|Total|Balance)\s+Payable|(?:Bedrag|Saldo|Totaal)\s+(?:Verskuldig|Betaalbaar))(?![A-Za-z])/i;
const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;
/**
 * Where the last line printing the total's figure ends — the total's position
 * when no total pattern knows its label (`Bedrag Verskuldig 1150.30`), so the
 * tax-below rule still judges it (round 32: it used to exempt such a total).
 */
function lastPrintEnd(text: string, total: number): number | null {
  let at = 0;
  let end: number | null = null;
  for (const line of text.split('\n')) {
    if (printedFigures(line).some((f) => near(f.value, total))) end = at + line.length;
    at += line.length + 1;
  }
  return end;
}

/** The tax figure that shows the total read excludes it, or null. */
export function preTaxTotal(text: string, total: number, vat: number | null, settled: boolean): number | null {
  if (vat === null || vat <= 0) return null;
  const lines = text.split(/\r?\n/);
  const totalLines = lines.filter((line) => printedFigures(line).some((f) => near(f.value, total)));
  if (totalLines.some((line) => (PRE_TAX.test(line) || NET_AFTER.test(afterFigure(line))) && !INCLUDED.test(line))) return vat;
  const end = totalPrintedLastEnd(text, total) ?? lastPrintEnd(text, total);
  const markedItem = end !== null && marksAnItem(text, end);
  const inclusiveByArithmetic = isInclusiveTax(vat, total) && !markedItem && totalLines.some((line) => PAYABLE.test(line));
  if (settled || inclusiveByArithmetic || totalLines.some((line) => INCLUDED.test(line))) return null;
  if (end === null) return null;
  const taxAbove = printedFigures(text.slice(0, end)).some((f) => f.isSummary && near(f.value, vat));
  if (taxAbove) return null;
  const added = text.slice(end).split(/\r?\n/)
    .find((line) => isTaxOnlyLine(line) && !INCLUDED.test(line) && printedFigures(line).some((f) => f.value !== 0));
  return added === undefined ? null : vat;
}
