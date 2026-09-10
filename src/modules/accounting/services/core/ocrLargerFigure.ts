/**
 * Does the document print a figure larger than the total it was read with?
 *
 * The unattended gate used to measure "unambiguous" over the TOTAL CANDIDATES,
 * and the candidates are defined by LABELS. A payable printed under a label
 * the vocabulary does not know is not a candidate, so the slip looked as if it
 * printed one total and posted it. Six review rounds each added the labels the
 * last reviewer found — `Amount Due`, `TOTAAL`, `TE BETAAL`, `Balance` — and
 * each next reviewer found more: `Sub Total 200.00 / VAT 15% 30.00 / Total
 * 230.00 / Gratuity 23.00 / <label> 253.00` posted R230.00 against a payable of
 * R253.00 for `AMT DUE`, `Please Pay`, `Verskuldig`, `SALE`, `Amount Paid`,
 * `ZAR`, and `Tip 23.00 / CARD 253.00`. A label list has no end.
 *
 * This measures AMOUNTS instead, so it needs no vocabulary and the next
 * unknown label cannot beat it: the payable of a purchase is the largest figure
 * it prints, so any figure larger than the total read is a figure the reader
 * did not account for. The one ordinary exception is cash: `TOTAL 23.00 / CASH
 * 50.00 / CHANGE 27.00` prints 50.00, and it is explained exactly when the
 * NEXT figure is a change line and tender − change is the total. The change
 * label is the only vocabulary here, and a spelling it lacks only refuses.
 *
 * It is a REFUSAL, never a picking rule: it may stop a document posting, and
 * nothing it finds is ever offered as the payable.
 */
import { parseAmount } from './ocrAmountParsing';
import { UNRECONCILED_WARNING, totalPrintedEnd } from './ocrAmountReconciliation';

/**
 * A printed money figure: it carries a decimal part, which is what keeps
 * registration numbers, card digits, slip numbers and phone numbers out.
 * Grouped with a comma or a point only — a space is handled below. The
 * lookbehind and the trailing `(?![\d.,]*\d)` refuse to read part of a longer
 * run (a date `01.09.2026`), and `(?!\s*%)` keeps a VAT rate out.
 */
const FIGURE = /(?<![\d.,])(-?(?:\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{1,2})(?![\d.,]*\d)(?!\s*%)/g;

/**
 * A figure grouped with a SPACE (`1 253.00`) — read as thousands only when it
 * is the LAST figure on its line, whatever text follows it (`AMT DUE 1 265.00
 * ZAR`, `R1 265.00 (incl)`). Where another figure follows, the same shape is an
 * item row's quantity and unit price (`USB Cable 1 149.00 149.00`), and reading
 * that as R1 149.00 would refuse every invoice with a single-digit quantity and
 * a three-digit price.
 */
const SPACE_GROUPED = /(?<![\d.,])(\d{1,3}(?:[ \u00A0]\d{3})+[.,]\d{1,2})(?![\d.,]*\d)/g;

/**
 * The label of the change a cash tender gives back. Not `Chg`: on SA slips it
 * means CHARGE (`Svc Chg`, `Del Chg`) at least as often, and `Please Pay 253.00
 * incl Svc Chg 23.00` then "netted" to a Total of 230.00 and posted it.
 */
const CHANGE_LABEL = /(?<![A-Za-z])(?:Change|Wisselgeld|Kleingeld)(?![A-Za-z])/i;

/**
 * The label of a CASH tender. Only cash gives change: `CARD 253.00 / Change
 * 23.00` under a Total of 230.00 is a tip mislabelled, not a tender and its
 * change. A cash spelling missing here only refuses.
 */
const CASH_LABEL = /(?<![A-Za-z])(?:Cash|Tender(?:ed)?|Kontant)(?![A-Za-z])/i;

/**
 * A figure printed NEGATIVE: a glued minus (`-23.00`, `-R23.00`, `R -23.00`),
 * a trailing minus or parentheses. A spaced dash is a label separator.
 */
const NEGATIVE_FIGURE = /(?<![\d.,])(?:[-–](?:R|ZAR)?(\d+[.,]\d{2})|\(\s*(?:R|ZAR)?\s*(\d+[.,]\d{2})\s*\)|(\d+[.,]\d{2})-(?!\d))(?![\d.,]*\d)/g;

/**
 * A charge added ON TOP of a total: a tip, a gratuity, a service charge, a
 * delivery fee. A split tender (`Tip 23.00 / VISA 126.50 / MASTERCARD 126.50`)
 * prints no figure larger than the total, so only the addition's name shows
 * that the payable is more. This vocabulary only ever REFUSES.
 */
const ADDITION_LABEL = /(?<![A-Za-z])(?:Tips?|Gratuit(?:y|ies)|Fooi|Service\s*(?:Charge|Chg|Fee)|Svc(?:\s*Chg)?|Delivery(?:\s*(?:Fee|Charge))?|Del\s*Chg)(?![A-Za-z])[\s:.=R]*(?:incl(?:uded|\.)?[\s:.=R]*)?(\d+(?:[.,]\d{1,2})?)(?![\d.,]*\d)/gi;

interface PrintedFigure {
  value: number;
  /** A change label stands between this figure and the one before it on its line. */
  isChange: boolean;
  /** A cash label stands between this figure and the one before it on its line. */
  isCash: boolean;
}

function printedFigures(text: string): PrintedFigure[] {
  const figures: PrintedFigure[] = [];
  for (const line of text.split(/\r?\n/)) {
    const onLine: Array<PrintedFigure & { end: number }> = [];
    let labelFrom = 0;
    for (const match of line.matchAll(FIGURE)) {
      onLine.push({
        value: parseAmount(match[1]!),
        isChange: CHANGE_LABEL.test(line.slice(labelFrom, match.index)),
        isCash: CASH_LABEL.test(line.slice(labelFrom, match.index)),
        end: match.index + match[0].length,
      });
      labelFrom = match.index + match[0].length;
    }
    const last = onLine[onLine.length - 1];
    const grouped = last && [...line.matchAll(SPACE_GROUPED)].find((m) => m.index + m[0].length === last.end);
    if (grouped) last!.value = parseAmount(grouped[1]!);
    figures.push(...onLine.map(({ value, isChange, isCash }) => ({ value, isChange, isCash })));
  }
  return figures;
}

/**
 * The first printed figure larger than `total` that a tender and its change do
 * not explain, or null when the total is the largest figure on the document.
 */
export function unexplainedLargerFigure(text: string, total: number): number | null {
  const figures = printedFigures(text);
  const explained = new Set<number>();
  for (let i = 0; i + 1 < figures.length; i++) {
    const tender = figures[i]!;
    const change = figures[i + 1]!;
    if (tender.isCash && !tender.isChange && change.isChange
      && Math.round((tender.value - change.value) * 100) / 100 === total) {
      explained.add(i).add(i + 1);
    }
  }
  const culprit = figures.find((f, i) => f.value > total && !explained.has(i));
  return culprit ? culprit.value : null;
}

/**
 * A charge added to, or a deduction taken from, the total AFTER it is printed
 * — a positive tip, gratuity, service charge or delivery fee, or any figure
 * printed negative (`Staff Discount -23.00 / CARD 230.00` under a Total of
 * 253.00). Either way the total is not what was paid. Null when there is none;
 * printed BEFORE the total, a charge or a discount is inside it.
 */
export function adjustmentAfterTotal(text: string, total: number): number | null {
  const end = totalPrintedEnd(text, total);
  if (end === null) return null;
  const after = text.slice(end);
  for (const match of after.matchAll(ADDITION_LABEL)) {
    const value = parseAmount(match[1]!);
    if (value > 0) return value;
  }
  for (const match of after.matchAll(NEGATIVE_FIGURE)) {
    const value = parseAmount(match[1] ?? match[2] ?? match[3]!);
    if (value > 0) return -value;
  }
  return null;
}

/**
 * The same finding, for the person on the capture screen. Under the
 * reconciliation prefix, so the stored document carries it and the gate and
 * the AP routes refuse on it even before they re-read the text.
 */
export function largerFigureWarning(text: string, total: number | null): string | null {
  if (total === null || total <= 0) return null;
  const larger = unexplainedLargerFigure(text, total);
  if (larger === null) return null;
  return `${UNRECONCILED_WARNING} (total ${total.toFixed(2)}, printed ${larger.toFixed(2)}) — the document `
    + 'prints a figure larger than the total read, which may be the payable. Check it before posting.';
}
