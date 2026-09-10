/**
 * The money figures a document PRINTS, each tagged with what its own line says
 * it is — a payment, change, cash, or a net/tax/total summary.
 *
 * Split out of `ocrLargerFigure` in K-072 round 17, when reading whole-rand
 * figures and summary roles took that file past the 300-line cap. This module
 * READS; `ocrLargerFigure` decides. Nothing here refuses or posts anything.
 * Whole numbers are found by `ocrWholeFigures` and given their role here.
 */
import { parseAmount } from './ocrAmountParsing';
import { SUMMARY_LINE_START } from './ocrAmountPatterns';
import { wholeTokens } from './ocrWholeFigures';

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
 * The label of ANY payment: what the document says it was settled with. Cash
 * is one of them, and only cash gives change.
 *
 * This is the one vocabulary the arithmetic below needs, and it is a closed
 * set — a country has a handful of ways to pay, where it has no end of names
 * for a charge (`Tip`, `Gratuity`, `Waiter`, `Fooi`, `Service`, `Freight`,
 * `Handling`, `Surcharge`, `Levy`, `Car Guard`...). Six rounds tried to name
 * the charges; this names the payments instead and lets the arithmetic find
 * the charge, whatever it is called. Bare `Account` is deliberately absent:
 * on a trade slip `Account Balance 12 345.67` is not a payment, while `Staff
 * Account` and `On Account` are. Multi-word payments (`Debit Order`) come
 * FIRST, because the alternation takes the first spelling that matches and
 * `Debit` alone would leave `Order` between the label and its figure.
 */
const TENDER_LABEL = /(?<![A-Za-z])(?:(?:Debit|Stop)\s*Order|Medical\s*Aid|Aftrekorder|Remit(?:tance)?|Cash|Kontant|Tender(?:ed)?|Card|Kaart|Visa|Master(?:\s*card)?|Maestro|Amex|American\s+Express|Diners|Debit|EFT|Snap\s*Scan|Scan\s*to\s*Pay|Zapper|Yoco|Ozow|Pay\s*Shap|SCode|Speedpoint|Voucher|Cheque|Payment|Paid|Points|Loyalty|eBucks|UCount|Miles|(?:Staff|Store|House|Trade|On)\s+Account|Betaal\w*|Betaling|(?:Capitec|Apple|Samsung|Google|FNB|Nedbank|Absa|Standard\s+Bank|Mobile|Instant)\s*(?:Pay|Money|EFT))(?![A-Za-z])/i;

/**
 * Loyalty payments. Spent, they are money and print cents (`POINTS 15.00`);
 * EARNED, they are a count and print none (`Smart Shopper points 5`). So a
 * whole number labelled only by one of these is not a payment.
 */
const LOYALTY_LABEL = /^(?:Points|Loyalty|eBucks|UCount|Miles)$/i;

/**
 * What may stand between a payment's name and its amount: separators, a
 * currency mark, and the handful of nouns a till prints inside a tender line
 * (`Card Amount 449.50`, `Fleet card R 1 140.47`). ANYTHING ELSE means the
 * payment word was not labelling this figure at all — `Credit card surcharge
 * 5.00` is a charge, `points balance 1 250.00` is a loyalty balance, and
 * `Logitech MX Master 3S 1 899.00` is a mouse. Measured: without this, all
 * three were summed as payments and refused three ordinary slips.
 *
 * Its failure direction is safe. An unlisted connector only stops a figure
 * counting as a payment, and rule 3 of `unreconciledFigure` then refuses the
 * document because nothing explains it.
 */
const TENDER_CONNECTOR = /^(?:[\s:.=*#()\/-]|\d+|R\b|ZAR\b|Credit\b|Debit\b|Cr\b|Dr\b|Amount\b|Amt\b|Total\b|Due\b|Tendered\b|Paid\b|Payment\b|No\b)*$/i;

/** Does a payment label stand IMMEDIATELY before this figure on its line? */
function labelsTender(segment: string, whole = false): boolean {
  const matches = [...segment.matchAll(new RegExp(TENDER_LABEL.source, 'gi'))];
  const last = matches[matches.length - 1];
  if (last === undefined || (whole && LOYALTY_LABEL.test(last[0]))) return false;
  return TENDER_CONNECTOR.test(segment.slice(last.index + last[0].length));
}

/** Does a payment word OPEN this text — `23 CASH`, `230.00 VISA`? */
function startsWithTender(after: string): boolean {
  const match = new RegExp(`^\\s*(?:${TENDER_LABEL.source.slice(TENDER_LABEL.source.indexOf('(?:'))})`, 'i').exec(after);
  return match !== null && !LOYALTY_LABEL.test(match[0].trim());
}

/**
 * What may stand between a summary label and a WHOLE figure. A cents figure on
 * a line that opens with `Total`, `VAT` or `Amount Due` is that figure; a whole
 * number there may be something else the line counts — `Total Items 5`.
 */
const SUMMARY_CONNECTOR = /^(?:[\s:.=*#()\/-]|@|R\b|ZAR\b|\d+(?:[.,]\d+)?\s*%)*$/i;

function summaryAdjacent(line: string, index: number): boolean {
  const lead = line.length - line.trimStart().length;
  const match = SUMMARY_LINE_START.exec(line.trimStart());
  return match !== null && SUMMARY_CONNECTOR.test(line.slice(lead + match[0].length, index));
}

export interface PrintedFigure {
  value: number;
  /** A change label stands between this figure and the one before it on its line. */
  isChange: boolean;
  /** A cash label stands between this figure and the one before it on its line. */
  isCash: boolean;
  /** Any payment label stands between this figure and the one before it. */
  isTender: boolean;
  /** The figure's own LINE begins with a net, tax, total or payable label. */
  isSummary: boolean;
  /** A whole number that nothing marks as money and no role claims. */
  isUnroled: boolean;
  /** Another money figure is printed on the same line. */
  besideMoney: boolean;
}

/**
 * Every figure the document prints, cents and whole, in reading order, each
 * with the role its own line gives it. ONE reader for all three rules of the
 * whitelist — round 17 read whole numbers for rule 3 alone, and a whole-rand
 * payment was excused by rule 3 without ever reaching rule 1's sum.
 */
export function printedFigures(text: string): PrintedFigure[] {
  const figures: PrintedFigure[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cents = [...line.matchAll(FIGURE)].map((m) => ({
      value: parseAmount(m[1]!), index: m.index, end: m.index + m[0].length, whole: false, moneyMark: true, identifier: false,
    }));
    const lastCents = cents[cents.length - 1];
    const grouped = lastCents && [...line.matchAll(SPACE_GROUPED)].find((m) => m.index + m[0].length === lastCents.end);
    if (grouped) {
      lastCents!.value = parseAmount(grouped[1]!);
      lastCents!.index = grouped.index;
    }
    const whole = wholeTokens(line, cents.map((c) => [c.index, c.end] as const), startsWithTender)
      .map((t) => ({ ...t, whole: true }));
    const onLine: Array<PrintedFigure & { end: number; identifier: boolean }> = [];
    let labelFrom = 0;
    for (const f of [...cents, ...whole].sort((x, y) => x.index - y.index)) {
      const segment = line.slice(labelFrom, f.index);
      const isTender = labelsTender(segment, f.whole);
      const isChange = CHANGE_LABEL.test(segment);
      const isSummary = f.whole ? summaryAdjacent(line, f.index) : SUMMARY_LINE_START.test(line.trimStart());
      onLine.push({
        value: f.value,
        isChange,
        isCash: CASH_LABEL.test(segment),
        isTender,
        isSummary,
        isUnroled: f.whole && !f.moneyMark && !isTender && !isChange && !isSummary,
        besideMoney: false,
        end: f.end,
        identifier: f.identifier,
      });
      labelFrom = f.end;
    }
    // A payment names itself AFTER its figure as often as before it — `Waiter
    // 23.00 CASH`, `230.00 VISA`. Only the last figure on the line may claim
    // the trailing text, so a two-figure item row cannot smear one label over
    // both. Measured: without this, a tip settled in cash beside a card
    // payment equal to the total still auto-posted the total.
    const last = onLine[onLine.length - 1];
    if (last && startsWithTender(line.slice(last.end))) {
      last.isTender = true;
      last.isUnroled = false;
    }
    // A reference carries no role unless one claims it (`EFT 1500` is a
    // payment; `Terminal 12345` is not an amount at all).
    const kept = onLine.filter((f) => !f.identifier || !f.isUnroled);
    const money = kept.filter((f) => !f.isUnroled).length;
    figures.push(...kept.map(({ value, isChange, isCash, isTender, isSummary, isUnroled }) => ({
      value, isChange, isCash, isTender, isSummary, isUnroled, besideMoney: money - (isUnroled ? 0 : 1) > 0,
    })));
  }
  return figures;
}
