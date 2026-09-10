/**
 * The ITEM COLUMN and the SUMMARY BLOCK of a document, read against its total.
 *
 * Split out of `ocrLargerFigure` in K-072 round 24, when these checks took
 * that file past the 300-line cap. Like it, this only ever REFUSES.
 *
 * A whole number printed as a LINE ITEM, above the total block — `Waiter 23`
 * over `Sub Total 200.00 / VAT 15% 30.00 / Total 230.00` (round-17 review,
 * posted R230.00 against R253.00) — is seen by nothing below the total. What
 * sees it is the item column's own sum: the last figure of every item line
 * must add up to the net or to the total where an item line prints a whole
 * number and nothing else (`Cappuccino 35 / Muffin 30 / TOTAL 65.00` adds up
 * and passes), and must not EXCEED both anywhere (round 23).
 *
 * On a document NO payment settles, two more things refuse (round 24): rows
 * that land between the net and the total (a charge smaller than the VAT —
 * `Delivery 100.00` beside `Labour 1000.00` under `Sub Total 1000.00`), and
 * any figure in the summary block that is not a summary line (`Sub Total /
 * Delivery 350.00 / VAT / TOTAL`). A paid document is spared both: the
 * payment proves what was owed, and a card surcharge inside a paid total is
 * ordinary. On it too, a row equal to the tax refuses where the rows sum to
 * the total (round 25). `net` is the stored net, or total − VAT when the model
 * stored none: a null subtotal must not switch these checks off.
 */
import { printedFigures, type CountIsCounter } from './ocrPrintedFigures';

/**
 * A balance carried from a PRIOR document — not an item of this one. The line
 * must BE the label and its figure: `Interest on previous balance 350.00` and
 * `Opening balance adjustment 350.00` are charges (r23 HIGH-2).
 */
const PRIOR_BALANCE = /^[\s*:-]*(?:Balance\s+(?:brought\s+forward|b\/?f|forward)|Previous\s+balance|Opening\s+balance|Vorige\s+saldo|Saldo\s+oorgebring)[\s:=-]*(?:R\s*)?-?\d[\d\s.,]*$/i;

const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;

/** What rule 1 of `unreconciledFigure` established about the payments. */
export interface PaymentState {
  /** The payments sum to the total. */
  settled: boolean;
  /** …and a cash tender's change entered that sum, so a change line is explained. */
  cashChange: boolean;
}

export function unexplainedItem(
  text: string, total: number, net: number | null, isCounter: CountIsCounter, paid: PaymentState,
): number | null {
  const lines = text.split(/\r?\n/);
  // The block starts at the first line printing a SUMMARY figure — the header's
  // `VAT No 4123456789` prints none, and `Total Items 350` or `Tax Class 350`
  // above the sub total opens with a summary word but its figure is not one.
  const block = lines.findIndex((line) => printedFigures(line, isCounter).some((f) => f.isSummary));
  if (!paid.settled && block >= 0) {
    const end = lines.findIndex((line, i) => i >= block
      && printedFigures(line, isCounter).some((f) => f.isSummary && Math.abs(f.value - total) <= 0.01));
    // A summary figure is explained by VALUE as well as role, as rule 3 below
    // the total is (round 25): it is the net or the tax, or it and another
    // summary figure add up to the total. `Total Freight 350.00` and `VAT on
    // delivery 52.50` open with a summary word and are neither.
    const inBlock = lines.slice(block, Math.max(end, block)).flatMap((line) => printedFigures(line, isCounter));
    const explained = (f: typeof inBlock[number], i: number) => f.isSummary
      && ((net !== null && (near(f.value, net) || near(f.value, total - net)))
        || inBlock.some((g, j) => j !== i && g.isSummary && near(f.value + g.value, total)));
    const stray = inBlock.find((f, i) => f.value !== 0 && !explained(f, i));
    if (stray) return stray.value;
  }
  const body = block < 0 ? lines : lines.slice(0, block);
  const items = body.map((line) => printedFigures(line, isCounter));
  const lineSum = (rows: typeof items) => Math.round(rows.reduce((acc, row) => acc + (row[row.length - 1]?.value ?? 0), 0) * 100) / 100;
  const isLoose = (row: typeof items[number]) => row.length === 1 && row[0]!.isUnroled;
  const loose = items.find(isLoose);
  if (!loose) {
    // Rows that sum to MORE than both the net and the total carry a charge
    // neither covers (`Labour 1000.00 / Delivery 350.00` under `Sub Total
    // 1000.00`). Under-summing rows (a dropped line, `40.00L` on a fuel slip)
    // leave the printed total the payable. A payment row, a cash tender's
    // change and a named prior balance are not items.
    const rows = body.filter((line) => !PRIOR_BALANCE.test(line)).map((line) => printedFigures(line, isCounter))
      .filter((row) => row.length > 0 && !row.some((f) => f.isTender || (f.isChange && paid.cashChange)));
    const sum = lineSum(rows);
    const overBoth = sum > total + 0.01 && (net === null || sum > net + 0.01);
    const betweenUnpaid = !paid.settled && net !== null && sum > net + 0.01 && sum < total - 0.01;
    // Rows that sum to the total are what a VAT-inclusive column prints — and
    // also what a charge equal to the tax prints (`Delivery 150.00` beside
    // `Labour 1000.00` under `Sub Total 1000.00 / VAT 150.00`). No label tells
    // them apart (`Burger 100.00 / Sauce 15.00` is honest), so on an UNPAID
    // document a row equal to the tax refuses (round 25).
    const taxRow = !paid.settled && net !== null && near(sum, total) && rows.length > 1
      && rows.some((row) => near(row[row.length - 1]!.value, total - net));
    return overBoth || betweenUnpaid || taxRow ? sum : null;
  }
  const matches = (sum: number) => [total, net].some((target) => target !== null && Math.abs(sum - target) <= 0.01);
  // If the priced rows ALREADY add up to the net or the total, the loose whole
  // number is an extra on top of them, however neatly the grand sum lands:
  // `Hake 200.00 / Cake cutting per Table 30` under `Sub Total 200.00 /
  // Total 230.00` sums to the total only because the charge equals the VAT.
  if (matches(lineSum(items.filter((row) => !isLoose(row))))) return loose[0]!.value;
  return matches(lineSum(items)) ? null : loose[0]!.value;
}
