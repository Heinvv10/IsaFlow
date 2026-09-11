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
 *      the standard-rate tax inside the total (`TOTAL 147.40 / VAT 19.23`). A paid slip's recap under a total the tender
 *      settles is not judged: the payment proves the payable.
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

const PRE_TAX = /(?<![A-Za-z])(?:Excl\w*|Exclusive|Ex\.?\s*(?:VAT|BTW|Tax)|before\s+(?:VAT|BTW|tax)|nett?\s+of\s+(?:VAT|BTW|tax)|pre[\s-]?tax)(?![A-Za-z])/i;
const INCLUDED = /(?<![A-Za-z])(?:Incl\w*|Inclusive|included|portion)(?![A-Za-z])/i;
const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;

/** The tax figure that shows the total read excludes it, or null. */
export function preTaxTotal(text: string, total: number, vat: number | null, settled: boolean): number | null {
  if (vat === null || vat <= 0) return null;
  const lines = text.split(/\r?\n/);
  const totalLines = lines.filter((line) => printedFigures(line).some((f) => near(f.value, total)));
  if (totalLines.some((line) => PRE_TAX.test(line) && !INCLUDED.test(line))) return vat;
  if (settled || isInclusiveTax(vat, total) || totalLines.some((line) => INCLUDED.test(line))) return null;
  const end = totalPrintedLastEnd(text, total);
  if (end === null) return null;
  const taxAbove = printedFigures(text.slice(0, end)).some((f) => f.isSummary && near(f.value, vat));
  if (taxAbove) return null;
  const added = text.slice(end).split(/\r?\n/)
    .find((line) => isTaxOnlyLine(line) && !INCLUDED.test(line) && printedFigures(line).some((f) => f.value !== 0));
  return added === undefined ? null : vat;
}
