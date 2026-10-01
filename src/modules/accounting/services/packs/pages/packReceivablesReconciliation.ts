/**
 * TWO RECEIVABLES FIGURES IN ONE PACK, FOUR AND A HALF TIMES EITHER OF THEM
 * APART, AND NOT A SENTENCE JOINING THEM.
 *
 * Page 11 of the live client pack states "Blitz Fibre owes 3 192, 77.0% of
 * all debtors owed on the aged debtors report, which come to 4 146" and asks
 * the board to decide whether to refer a NAMED third party's account for
 * write-off. Page 7, the facing sheet, states trade receivables of (330).
 * A director's first question at the table is which of those two is the
 * company's debtors balance, and the pack had no answer printed in it. Worse,
 * 3 192 is also that page's printed Total assets — R3 191 824 against
 * R3 191 945, two different amounts that round to the same R'000 — which no
 * reader can distinguish from a data error.
 *
 * THE ROUND BEFORE THIS ONE NAMED THE SOURCES AND THOUGHT THAT CLOSED IT.
 * It did not, and the reason is worth writing down: naming two sources
 * explains why two figures MIGHT differ. It does not explain why THESE two
 * differ by 4 476, and a reader who is told the measures are different and
 * left to assume the difference is therefore fine has been misled more
 * efficiently than one who was told nothing.
 *
 * WHAT THE LEDGER ACTUALLY SAYS, measured on `isaflow_dev` at 7 September
 * 2026 rather than reasoned about:
 *
 *   - the aged debtors report totals R4 145 971.50, and the full open AR
 *     subledger R4 164 721.50 including two documents with no due date;
 *   - account 1120, Accounts Receivable, holds a CREDIT of R329 700;
 *   - not one of the 29 open customer invoices appears on it. The only
 *     invoice-shaped journals on the control account are synthetic monthly
 *     pairs unrelated to any subledger document, and every one of those lines
 *     is `reversed`;
 *   - the whole of the credit is residue from a reversal run on 13 April
 *     2026 which reversed two months' sales invoices twice against their
 *     receipts once — February 2026 at R170 200 and October 2025 at
 *     R149 500 — plus a R10 000 customer payment with no invoice behind it.
 *     170 200 + 149 500 + 10 000 = 329 700, exactly.
 *
 * So the subledger and the general ledger do not disagree about a
 * classification. They disagree about whether the receivables exist, and
 * neither figure can be derived from the other. This is a defect in the books
 * rather than in the pack, and a board pack's job when it meets one is to say
 * so on the sheet that prints the claim — not to reconcile it in prose it
 * cannot support, and not to leave it for the meeting.
 *
 * WHAT THIS NOTE THEREFORE DOES AND DOES NOT SAY. It states both figures,
 * their difference, which source each comes from, and that this pack does not
 * reconcile them. It states NO CAUSE. The cause above is one company's, read
 * off one database on one day; a sentence generalising it would be the same
 * mistake the last round made, one level of confidence further on. And it
 * withholds nothing else: the decision the concentration matter asks for is
 * explicitly conditioned on the difference being explained first, because a
 * write-off referred against a subledger the ledger does not carry is a
 * decision taken on a figure nobody has stood behind.
 *
 * IT IS BUDGETED, NOT APPENDED. Page 11 is the one page in the pack whose
 * CONTENT depends on how much paper it has left: `mattersBudgetMm` subtracts
 * the support blocks before `selectPrintedMatters` chooses rows, so a note
 * added after the selection would be paper the page has already spent and
 * `fitPageToBox` would answer by making the sheet apologise. It goes in with
 * the other support blocks, where its cost is a matter row that moves into
 * the "N further matters are not printed" tail — a tail that states its own
 * count and its own quantum. A reconciliation of two printed figures outranks
 * a seventh row of a table that discloses what it left off.
 *
 * IT IS SILENT WHERE THE PACK PRINTS NO AGED-DEBTORS TOTAL. The demo company
 * has the same disagreement in its books — an aging total of R10 724 260
 * against a control balance of R59 240 — and no sheet of its pack states the
 * first figure, because its largest debtor is 17.8% of the book and the
 * concentration matter never fires. There is no contradiction on that paper
 * to reconcile, and a disclosure about a figure the pack does not print would
 * be the pack answering a question it has not raised.
 */
import { formatMoney, inProse, inScale, MONEY_SCALES, type MoneyScale } from '@/lib/format/money';
import { round2 } from '@/modules/accounting/services/reconciliation/reconciliationMath';
import { mustDisclose, note } from './packPageBlocks';
import type { PackPageBlock } from './packPageModel';
import type { ReconcilingItem } from '@/modules/accounting/services/reconciliation/reconcilingItemTypes';
import { decomposition } from './packReceivablesDecomposition';

export { RECEIVABLES_BASE_HEADING, receivablesBaseNote } from './packReceivablesBaseNote';

/**
 * WHAT THE PACK KNOWS ABOUT ITS OWN RECEIVABLES, read once in
 * `boardPackDocument.ts` and handed down.
 *
 * Three numbers and a decomposition, from two sources that must be kept
 * apart: `agedDebtorsTotal` and `subledgerTotal` come from the aging report
 * `buildMatters` already reads, and `items` comes from
 * `reconcileSubledger`. They are NOT interchangeable — the reconciliation
 * service's own `agedTotal` is the subledger total, 19 higher than the
 * bucket total the pack prints on page 11, and printing one where the other
 * belongs is how this sheet would acquire a fresh self-contradiction while
 * fixing one.
 */
export interface PackReceivablesRead {
  /** `getAgingReport(...).totals.total` — the figure page 11 prints, in rand.
   *  Null where no sheet of the pack states a debtors total. */
  agedDebtorsTotal: number | null;
  /** The full open subledger including documents that cannot be aged. Null
   *  where the aging report could not be read, which is already a matter. */
  subledgerTotal: number | null;
  /**
   * `reconcileSubledger`'s OWN reading of the control account, carried only
   * so the decomposition can be refused when it disagrees with the figure the
   * balance sheet prints. Two derivations of one balance is what
   * `assertConsistent` exists to refuse, and this note must not become the
   * place a third receivables figure enters the pack.
   */
  controlBalance: number | null;
  /** The `subledger_to_control` items, as the service returned them. */
  items: readonly ReconcilingItem[];
  /** The residual the service could not account for — `reconcileSubledger`'s
   *  own `unexplainedDifference`. It is what decides whether the closure
   *  clause may be printed; see `decomposition`. Null only where the
   *  subledger had no document-level source at all, in which case there are
   *  no items to list either. */
  unexplained: number | null;
}

/** The heading the note prints under. Exported so a test asserts THIS block
 *  rather than any disclosure that happens to mention receivables. */
export const RECEIVABLES_RECONCILIATION_HEADING = 'Two debtors figures';

/**
 * Page 11's receivables reconciliation, or null where the pack prints only
 * one debtors figure and there is nothing to reconcile.
 *
 * @param agedDebtorsTotal `getAgingReport(...).totals.total` in RAND, as
 *   `buildMatters` read it — null where no aged-debtors total is printed.
 * @param tradeReceivables `set.current.accountsReceivable` in RAND — the
 *   trade-receivable control account, which is the figure page 7 prints and
 *   page 7's memorandum footnote names.
 * @param scale The pack's money scale, so the three figures here print in the
 *   same unit as the matter above them.
 */
export function receivablesReconciliationNote(
  read: PackReceivablesRead,
  tradeReceivables: number,
  scale: MoneyScale,
): PackPageBlock | null {
  // THE HEADLINE IS THE HIGHEST FIGURE THE PACK ACTUALLY HAS, NOT THE AGED
  // TOTAL ALONE.
  //
  // This returned null wherever no sheet printed an aged-debtors total, and
  // on the live demo company that silenced a gap of R10.7m: an open customer
  // subledger of 10 724 against a control account of 59. The reasoning was
  // that a disclosure firing where a reader sees no conflict is noise — and
  // it was overtaken by the pack itself. Sheet 9 now prints
  // `Debtor days · 213 · target 30 · MISSED` in red, and sheet 4 says the
  // ratio is taken on a base it disowns. A red MISS is a printed judgement,
  // and the conflict a reader can see is between that judgement and the
  // caveat one page earlier.
  //
  // So the block fires on whichever debtors figure the pack has: the aged
  // report where one is printed, the subledger where it is not. The aged leg
  // is conditional — a sentence bridging a report this pack never read is a
  // third figure entering the page, which is the thing this file refuses
  // everywhere else.
  const { agedDebtorsTotal, subledgerTotal } = read;
  const headline = agedDebtorsTotal ?? subledgerTotal;
  if (headline === null) return null;
  const difference = round2(headline - tradeReceivables);
  // NIL DIFFERENCE, NO NOTE. A pack whose subledger and control account agree
  // has two figures that are the same figure, and a disclosure explaining
  // that they might not have been is noise on the page that can least afford
  // it.
  //
  // ROUNDED AT THE PACK'S SCALE, not compared as rands and not compared
  // against the dash. R40 of difference between two balances printed in
  // R'000 prints as `<1` — the pack's own glyph for "a real amount too small
  // to show at this scale" — and "a difference of <1" between two figures a
  // reader sees as 720 and 720 reads as an error in the note rather than a
  // finding about the books. The materiality this page can speak to is the
  // materiality it prints at. `Math.round` rather than the formatter,
  // because `formatMoney` has three different renderings of "small" (`–`,
  // `<1`, `(<1)`) and a comparison against one of them silently lets the
  // other two through.
  if (Math.round(difference / MONEY_SCALES[scale]) === 0) return null;

  const money = (n: number) => inProse(formatMoney(n, { scale }));
  const detail = decomposition(read, tradeReceivables, scale);
  // WHERE THE DECOMPOSITION PRINTS, IT NAMES BOTH SOURCES ITSELF — "an open
  // customer subledger of 4 165", "the trade-receivable control account in
  // the general ledger" — so the sentence that existed to name them is the
  // same fact twice, and page 11 is the one sheet in the pack that pays for a
  // repeated fact in matters rows. Keeping both cost live Brightsphere a
  // fourth row; the version below prints five and says everything the six-row
  // version said. Where the decomposition is refused, that sentence is the
  // only thing naming the two sources and it stays.
  const sources = detail === ''
    ? ' The first is the open customer subledger and the second the trade-receivable control '
      + 'account in the general ledger.'
    : '';
  return mustDisclose(RECEIVABLES_RECONCILIATION_HEADING, [
    // THE HEADING NAMES WHICH FIGURE IT IS BRIDGING FROM. A block headed
    // "Aged debtors against the balance sheet" over a sentence about the
    // subledger is a pointer to a report the pack never read.
    note(agedDebtorsTotal === null
      ? 'The subledger against the balance sheet'
      : 'Aged debtors against the balance sheet',
      inScale(
        `${agedDebtorsTotal === null ? 'The open customer subledger totals' : 'The aged debtors report totals'} `
        + `${money(headline)} and the balance sheet states `
        + `trade receivables of ${money(tradeReceivables)}, a difference of `
        + `${money(difference)}`,
        scale,
      )
      + `.${sources}${detail} On these books the two do not agree, this pack does not adjust `
      + 'either figure to the other, and the difference should be explained before any decision '
      + 'above that rests on a debtors balance is taken.'),
  ]);
}
