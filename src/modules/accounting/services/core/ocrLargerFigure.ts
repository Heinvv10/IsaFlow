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
import { UNRECONCILED_WARNING, totalPrintedEnd, totalPrintedLastEnd } from './ocrAmountReconciliation';
import { printedFigures, type PrintedFigure } from './ocrPrintedFigures';
import { SUMMARY_LINE_START } from './ocrAmountPatterns';

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
 * A VAT or tax RECAP block — `VAT ANALYSIS`, `TAX SUMMARY`, `BTW OPSOMMING`.
 *
 * Its rows decompose the total into rated bands and print no labels of their
 * own (`A 15.00% 100.00 15.00`, `Std Rated Incl 137.98 / Zero Rated 52.98`),
 * so rule 3 cannot read their role off their own line. The header says what
 * the block is, and the block's ARITHMETIC proves it: its unlabelled rows must
 * add up to the total, within a cent. A header alone would wave through
 * whatever was printed under it — `VAT ANALYSIS / Std Rated 137.98 / SERVICE
 * 23.00` — and that is the value-coincidence defect again by another route.
 * The header vocabulary is the last one in this file, and a spelling missing
 * from it only refuses.
 */
const RECAP_HEADER = /(?:VAT|BTW|TAX|BELASTING)[\s-]*(?:ANALYSIS|ANALISE|SUMMARY|OPSOMMING|BREAKDOWN|RECAP|DETAIL)/i;

/**
 * What a recap ROW may be labelled: a rated band and its columns. A row
 * carrying any other word is a charge sitting inside the block — `VAT
 * ANALYSIS / Std Rated 207.00 / SERVICE 23.00` sums to the total as neatly as
 * an honest recap does (round-17 review LOW-1). A single letter is a band code
 * (`A 15.00% 100.00 15.00`). A spelling missing here only refuses.
 */
const BAND_WORD = /^(?:Std|Standard|Standaard|Zero|Nul|Exempt(?:ed)?|Vrygestel|Rated|Rate|Koers|Incl\w*|Excl\w*|Net|Nett|VAT|BTW|Tax|Gross|Amount|Band|Code|[A-Z])$/i;
const BAND_NAMED = /(?<![A-Za-z])(?:Std|Standard|Standaard|Zero|Nul|Exempt(?:ed)?|Vrygestel)(?![A-Za-z])/i;

/**
 * The indexes, into `printedFigures(text)`, of the recap-block rows that
 * decompose `total` — or none, when they do not. Three things make a block a
 * recap and not a hiding place: its rows add up to the total within a cent;
 * no row is labelled with anything but a band; and either a row NAMES a band
 * (`Std Rated`, `Zero Rated`) or the block prints the tax itself. Unlabelled
 * rows that merely sum (`TAX SUMMARY / 200.00 / 7.00 / 23.00`) are not a
 * decomposition of anything.
 */
function recapRows(text: string, figures: readonly PrintedFigure[], total: number, vat: number | null): Set<number> {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line) => RECAP_HEADER.test(line));
  if (header < 0) return new Set();
  const before = printedFigures(lines.slice(0, header).join('\n')).length;
  const rows = figures.map((f, i) => ({ f, i }))
    .filter(({ f, i }) => i >= before && !f.isSummary && !f.isTender && !f.isChange && f.value !== 0);
  const sum = Math.round(rows.reduce((acc, { f }) => acc + f.value, 0) * 100) / 100;
  if (Math.abs(sum - total) > 0.01) return new Set();
  const block = lines.slice(header + 1);
  const labels = block.flatMap((line) => line.replace(/[\d.,%()@:*=/-]+/g, ' ').split(/\s+/).filter(Boolean));
  if (labels.some((word) => !BAND_WORD.test(word))) return new Set();
  const namesBand = block.some((line) => BAND_NAMED.test(line));
  const printsTax = vat !== null && figures.slice(before).some((f) => f.value === vat);
  return namesBand || printsTax ? new Set(rows.map(({ i }) => i)) : new Set();
}

/**
 * A whole number printed as a LINE ITEM, above the total block — `Waiter 23`
 * over `Sub Total 200.00 / VAT 15% 30.00 / Total 230.00` (round-17 review,
 * posted R230.00 against R253.00). Nothing below the total mentions it, so
 * rules 1 to 3 cannot see it. What can is the item column's own sum: the last
 * figure of every item line must add up to the net or to the total. Checked
 * only where an item line prints a whole number and nothing else, so a
 * cents-only document is judged exactly as before; `Cappuccino 35 / Muffin
 * 30 / TOTAL 65.00` adds up and passes.
 */
function unexplainedItem(text: string, total: number, net: number | null): number | null {
  const lines = text.split(/\r?\n/);
  // The block starts at the first summary line that prints a FIGURE — the
  // header's `VAT No 4123456789` opens with a summary word and prints none.
  const block = lines.findIndex((line) => SUMMARY_LINE_START.test(line.trimStart()) && printedFigures(line).length > 0);
  const items = (block < 0 ? lines : lines.slice(0, block)).map((line) => printedFigures(line));
  const isLoose = (row: typeof items[number]) => row.length === 1 && row[0]!.isUnroled;
  const loose = items.find(isLoose);
  if (!loose) return null;
  const lineSum = (rows: typeof items) => Math.round(rows.reduce((acc, row) => acc + (row[row.length - 1]?.value ?? 0), 0) * 100) / 100;
  const matches = (sum: number) => [total, net].some((target) => target !== null && Math.abs(sum - target) <= 0.01);
  // If the priced rows ALREADY add up to the net or the total, the loose whole
  // number is an extra on top of them, however neatly the grand sum lands:
  // `Hake 200.00 / Cake cutting per Table 30` under `Sub Total 200.00 /
  // Total 230.00` sums to the total only because the charge equals the VAT.
  if (matches(lineSum(items.filter((row) => !isLoose(row))))) return loose[0]!.value;
  return matches(lineSum(items)) ? null : loose[0]!.value;
}

/** Why a document's own figures do not reconcile against the total read. */
export interface Unreconciled {
  /** `paid` — the payments do not add up; `larger` — a bigger figure nothing
   *  explains; `stray` — a figure below the total block nothing explains. */
  reason: 'paid' | 'larger' | 'stray';
  value: number;
}

/**
 * Does the WHOLE document reconcile against the total it was read with?
 *
 * Round 15 asked the same question of a SLICE — the text after the printed
 * total — and the round-16 review beat it three ways with that alone: a split
 * tender printed ABOVE the total block (`VISA 126.50 / MASTERCARD 126.50 /
 * Sub Total 200 / VAT 30 / Total 230`) was never examined and posted R230.00
 * against a payable of R253.00; a charge printed BELOW the tender line was
 * skipped because a tender had been found; and a payment rail missing from
 * `TENDER_LABEL` simply dropped out of the sum. Seven rounds have now been
 * beaten by a rule that reads a position.
 *
 * So this is a WHITELIST, and it is measured over the whole document. Three
 * things must hold, and anything else goes to a person:
 *
 *  1. the payments, wherever they are printed, sum to the total (less change,
 *     and only where a CASH tender is printed — only cash gives change);
 *  2. no figure is LARGER than the total except one exactly equal to it (a
 *     repeated total, an amount-due box) or one the BALANCED payment sum in
 *     rule 1 already accounted for (`CASH 300.00` against `CHANGE 47.00`);
 *  3. nothing printed below the total block is left unexplained — a figure is
 *     explained only when its own LINE says what it is: a payment or change
 *     line, a zero, or a line that begins with a net, tax, total or payable
 *     label (`SUMMARY_LINE_START` — the reader's own summary vocabulary), or
 *     a row of a VAT/tax recap block whose rows add up to the total.
 *
 * Rule 3 is what makes `TENDER_LABEL` non-load-bearing in the dangerous
 * direction: a rail this file has never heard of leaves the CHARGE beside it
 * unexplained, and the document refuses whether or not the rail was
 * recognised. The vocabulary now only ever buys back an ordinary slip.
 *
 * Rule 3 explains by ROLE AND VALUE together. Round 16 used value alone, and a
 * charge that coincided with the tax, the net or the total was waved through
 * (`SERVICE 15.00`, `Car Guard 100.00`, `Second table 115.00`). Round 17 used
 * role alone, and `Total Service 23.00` or `VAT on service 23.00` explained
 * themselves by their first word. A summary line now explains its figure only
 * when that figure IS the total, the net or the tax.
 *
 * All three rules read the same figures, whole rands included (see
 * `ocrWholeFigures`): a whole-rand payment is summed by rule 1 and is larger
 * than the total under rule 2 exactly as its cents twin is. A whole number is
 * a COUNT only when a counter label names it (`Items 2`, `Table 12`, `Pump 5`
 * — `ocrPrintedFigures`); any other whole number no role claims is an amount
 * nobody explained, and refuses wherever it is printed, whatever was paid.
 * Round 18 licensed it as a count whenever the payments balanced, and a
 * handwritten tip (`Tip: ____ 23` under `CARD 230.00`) posted the pre-tip
 * total. `CARD 230.00 / Car Guard 23` refuses now too: the card proves what
 * was paid, but nothing on the document explains the 23.
 */
export function unreconciledFigure(
  text: string,
  total: number,
  known: { subtotal?: number | null; vatAmount?: number | null } = {},
): Unreconciled | null {
  const figures = printedFigures(text);
  const tenders = figures.filter((f) => f.isTender && !f.isChange);
  // `settled` records that rule 1 RAN AND BALANCED, which is the only thing
  // that lets rule 2 forgive a payment bigger than the total. Round 16 exempted
  // every tender and change figure unconditionally, which is wider than this
  // file's own comment claimed and would have forgiven a stray `Change 23.00`
  // printed with no tender at all.
  let settled = false;
  if (tenders.length > 0) {
    const hasCash = figures.some((f) => f.isCash && !f.isChange);
    const change = hasCash ? figures.filter((f) => f.isChange).reduce((sum, f) => sum + f.value, 0) : 0;
    const paid = Math.round((tenders.reduce((sum, f) => sum + f.value, 0) - change) * 100) / 100;
    if (Math.abs(paid - total) > 0.01) return { reason: 'paid', value: paid };
    settled = true;
  }

  const larger = figures.find((f) => f.value > total && !(settled && (f.isTender || f.isChange)));
  if (larger) return { reason: 'larger', value: larger.value };
  const item = unexplainedItem(text, total, known.subtotal ?? null);
  if (item !== null) return { reason: 'stray', value: item };

  const end = totalPrintedLastEnd(text, total);
  if (end === null) return null;
  const below = text.slice(end);
  const belowFigures = printedFigures(below);
  const recap = recapRows(below, belowFigures, total, known.vatAmount ?? null);
  const roleValues = new Set([0, total, known.subtotal ?? total, known.vatAmount ?? total]);
  const stray = belowFigures.find((f, i) => {
    if (f.value === 0 || f.isTender || f.isChange || recap.has(i)) return false;
    if (f.isSummary) return !roleValues.has(f.value);
    if (f.isUnroled) return true;
    return true;
  });
  return stray ? { reason: 'stray', value: stray.value } : null;
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
