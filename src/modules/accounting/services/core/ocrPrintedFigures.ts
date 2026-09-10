/**
 * The money figures a document PRINTS, each tagged with what its own line says
 * it is — a payment, change, cash, or a net/tax/total summary.
 *
 * Split out of `ocrLargerFigure` in K-072 round 17, when reading whole-rand
 * figures and summary roles took that file past the 300-line cap. This module
 * READS; `ocrLargerFigure` decides. Nothing here refuses or posts anything.
 */
import { parseAmount } from './ocrAmountParsing';
import { SUMMARY_LINE_START } from './ocrAmountPatterns';

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
 * A figure printed WITHOUT cents — `SERVICE 23`, `AMT DUE 253`, `Total 1 150`.
 *
 * `FIGURE` above requires a decimal part, which is what keeps card digits and
 * slip numbers out. The round-16 review turned that into a hole big enough to
 * drive the whole item through: a whole-rand charge was not a printed figure at
 * all, so rule 1 had no tender to sum, rule 2 found nothing larger than the
 * total and rule 3 found nothing to explain. `Total 230.00 / SERVICE 23 / AMT
 * DUE 253` posted R230.00 against R253.00 — 28 of 28 probes — while the same
 * text with `23.00` refused. The ONLY thing catching the whole-rand shape was
 * `ADDITION_LABEL`, the charge vocabulary this file argues can never be
 * finished.
 *
 * Read in TWO restricted places only, because whole numbers are what a
 * document prints most of: on a line that carries no cents figure at all (an
 * amount line prints cents, so a quantity column beside a priced item can
 * never be mistaken for one), and only BELOW the total block, where rule 3
 * looks. That second restriction is what keeps the header out — measured, the
 * unrestricted pattern read `Invoice No: 88123` and the `2026` of a date as
 * amounts and refused every document on this branch.
 *
 * Within that region: a leading zero is a document number, not an amount
 * (`Receipt No: 004512`, `Till 04`); more than five digits is an account or
 * branch number (`Branch 250655`, `Odometer 145230`) — so a whole-rand payable
 * above R99 999 is not read here, and prints cents in practice; a neighbouring
 * `:`, `/` or `-` is a date or a time; a number introduced by a
 * document-number label (`Delivery Note No: 4471`) is a reference, as is one
 * glued to a letter prefix (`DN4471`), and a label missing from that short
 * list only costs a refusal; a trailing `%` is a rate. What remains
 * is still noisier than `FIGURE` — `ClubCard points earned 7` reads as 7 — and
 * under a whitelist that is the safe direction: an unexplained figure refuses.
 */
const WHOLE_RAND = /(?<![A-Za-z\d.,:\/-])(?<!\b(?:No|Nr|Number|Ref|Doc|Order|Invoice|Receipt|Slip|Till|Acc|Account|Branch|Reg|Code|ID|Tel|Fax)[\s.:#-]{0,4})(?:R|ZAR)?\s?([1-9]\d{0,2}(?:[ \u00A0.,]\d{3})+|[1-9]\d{0,4})(?![\d.,]*\d)(?![:\/-]\d)(?=[\s*)\]]*$)/gm;

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
const TENDER_LABEL = /(?<![A-Za-z])(?:(?:Debit|Stop)\s*Order|Aftrekorder|Remit(?:tance)?|Cash|Kontant|Tender(?:ed)?|Card|Kaart|Visa|Master(?:\s*card)?|Maestro|Amex|American\s+Express|Diners|Debit|EFT|Snap\s*Scan|Scan\s*to\s*Pay|Zapper|Yoco|Ozow|Pay\s*Shap|SCode|Speedpoint|Voucher|Cheque|Payment|Paid|Points|Loyalty|eBucks|UCount|Miles|(?:Staff|Store|House|Trade|On)\s+Account|Betaal\w*|Betaling|(?:Capitec|Apple|Samsung|Google|FNB|Nedbank|Absa|Standard\s+Bank|Mobile|Instant)\s*(?:Pay|Money|EFT))(?![A-Za-z])/i;

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
function labelsTender(segment: string): boolean {
  const matches = [...segment.matchAll(new RegExp(TENDER_LABEL.source, 'gi'))];
  const last = matches[matches.length - 1];
  return last !== undefined && TENDER_CONNECTOR.test(segment.slice(last.index + last[0].length));
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
}

export function printedFigures(text: string, wholeRand = false): PrintedFigure[] {
  const figures: PrintedFigure[] = [];
  for (const line of text.split(/\r?\n/)) {
    const onLine: Array<PrintedFigure & { end: number }> = [];
    let labelFrom = 0;
    for (const match of line.matchAll(FIGURE)) {
      onLine.push({
        value: parseAmount(match[1]!),
        isChange: CHANGE_LABEL.test(line.slice(labelFrom, match.index)),
        isCash: CASH_LABEL.test(line.slice(labelFrom, match.index)),
        isTender: labelsTender(line.slice(labelFrom, match.index)),
        isSummary: SUMMARY_LINE_START.test(line.trimStart()),
        end: match.index + match[0].length,
      });
      labelFrom = match.index + match[0].length;
    }
    if (wholeRand && onLine.length === 0) {
      const whole = [...line.matchAll(WHOLE_RAND)].pop();
      if (whole) {
        onLine.push({
          value: parseAmount(whole[1]!),
          isChange: CHANGE_LABEL.test(line.slice(0, whole.index)),
          isCash: CASH_LABEL.test(line.slice(0, whole.index)),
          isTender: labelsTender(line.slice(0, whole.index)),
          isSummary: SUMMARY_LINE_START.test(line.trimStart()),
          end: whole.index + whole[0].length,
        });
      }
    }
    const last = onLine[onLine.length - 1];
    const grouped = last && [...line.matchAll(SPACE_GROUPED)].find((m) => m.index + m[0].length === last.end);
    if (grouped) last!.value = parseAmount(grouped[1]!);
    // A payment names itself AFTER its figure as often as before it — `Waiter
    // 23.00 CASH`, `230.00 VISA`. Only the last figure on the line may claim
    // the trailing text, so a two-figure item row cannot smear one label over
    // both. Measured: without this, a tip settled in cash beside a card
    // payment equal to the total still auto-posted the total.
    if (last && TENDER_LABEL.test(line.slice(last.end))) last.isTender = true;
    figures.push(...onLine.map(({ value, isChange, isCash, isTender, isSummary }) => (
      { value, isChange, isCash, isTender, isSummary })));
  }
  return figures;
}
