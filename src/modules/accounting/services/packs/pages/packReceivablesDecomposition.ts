/**
 * What the difference between the two debtors figures CONSISTS OF — the
 * clause each reconciling type prints, and the sentence page 11's note lists
 * them in. Moved out of `packReceivablesReconciliation.ts` unchanged to keep
 * that file under the 300-line cap; the header there states what this
 * sentence may and may not say.
 */
import { formatStatementFigure, inProse, MONEY_SCALES, type MoneyScale } from '@/lib/format/money';
import { round2 } from '@/modules/accounting/services/reconciliation/reconciliationMath';
import type { PackReceivablesRead } from './packReceivablesReconciliation';

/**
 * ONE CLAUSE PER RECONCILING TYPE, written for a director.
 *
 * A `Record` over the types the service emits rather than its own
 * `description`, for two reasons. The descriptions carry a developer's
 * plural — "984 posted journal(s)", "169 open document(s)" — which is the
 * exact thing `packMatters.plural` exists to keep off these sheets; and they
 * are written for whoever is going to FIX the ledger, at three or four lines
 * each, on the one page in the pack whose paper is measured in matters rows.
 *
 * Each clause says WHAT the amount consists of and nothing about why it
 * arose. `unexplained_difference` gets one too: a residual the reconciliation
 * could not account for is the most important item in the list, and it must
 * not be the one that falls through a lookup.
 */
const ITEM_CLAUSE: Record<string, string> = {
  unapplied_receipt: 'receipts credited to the control account and not applied to a document',
  posting_with_no_document: 'postings that reference no document',
  document_not_linked_to_journal: 'open documents carrying no link to a journal entry',
  document_not_on_control_account: 'open documents whose linked journal has not reached the control account',
  // Credit the note's journal put on the control account and no document has
  // yet consumed, so the subledger does not carry it.
  unapplied_credit_note: 'approved credit notes not applied to any document',
  // Timing: the documents are not in the subledger at the reporting date and
  // the cash applied to them in advance is already on the control account.
  settlement_before_document: 'documents dated after the reporting date and settled on or before it',
  // The residual carries no population, so `across N` is suppressed for it
  // by `documentIds` being empty — which is the service's own shape, not a
  // special case written here.
  unexplained_difference: 'left over, which this reconciliation could not account for',
};

/**
 * WHAT THE DIFFERENCE CONSISTS OF — the sentence that ends the investigation
 * rather than opening it.
 *
 * "A difference of 4 476, unreconciled" tells a board there is a problem and
 * gives them no first question. `reconcileSubledger` has always been able to
 * say that 4 175 of it is open documents carrying no link to a journal entry
 * and 320 is postings referencing no document, itemised down to document
 * ids, point-in-time correct on both sides — nothing connected that service
 * to this pack.
 *
 * IT STATES THE SUBLEDGER AS ITS OWN BASE, and that is arithmetic rather than
 * thoroughness. The items decompose the gap between the SUBLEDGER and the
 * control account; the sentence above them states the gap between the AGED
 * REPORT and the control account, and on the live client those differ by the
 * 19 of documents that carry no due date and so reach no aging bucket. Printed
 * against the wrong base the list fails to add up by 19, on the one sheet in
 * the pack whose whole purpose this round is to make two figures add up. So
 * the bridge is stated in full: report, then subledger, then control account.
 *
 * IT STILL STATES NO CAUSE. "Open documents carrying no link to a journal
 * entry" is what the amount CONSISTS OF; why 29 invoices were never posted is
 * not something this pack has measured, and the ruling that produced this
 * paragraph said so explicitly.
 *
 * AND IT REFUSES ITSELF RATHER THAN INTRODUCING A THIRD FIGURE. The
 * reconciliation reads the control account through
 * `getControlAccountBalances` and the balance sheet reads it through
 * `aggregateFigures`; where those two disagree, the decomposition is
 * describing a gap that is not the gap the sentence above states, and the
 * honest answer is the shorter note. Same for a subledger the aging report
 * could not give us, and for a service that returned no items at all.
 */
export function decomposition(
  read: PackReceivablesRead,
  tradeReceivables: number,
  scale: MoneyScale,
): string {
  const { subledgerTotal, controlBalance, items } = read;
  if (subledgerTotal === null || controlBalance === null) return '';
  // The guard: two readings of one balance must agree to the cent before the
  // items are allowed to describe the difference between them.
  if (round2(controlBalance) !== round2(tradeReceivables)) return '';

  // A TYPE THIS PAGE CANNOT WORD REFUSES THE DECOMPOSITION, NOT JUST ITS
  // CLOSURE SENTENCE. `ReconcilingItem['type']` is an open set by design, and
  // the list used to print whatever it had a clause for: on a tenant carrying
  // `unapplied_credit_note` or `settlement_before_document` — both added to
  // the service after this table was written — a director was shown a list
  // of parts with money missing from it and nothing saying so. A partial
  // decomposition is not a shorter one. The fallback is the note that names
  // the two sources and says they are not reconciled, the same refusal as the
  // guard above.
  if (items.some((item) => ITEM_CLAUSE[item.type] === undefined && round2(item.amount) !== 0)) {
    return '';
  }

  const named = items
    .filter((item) => round2(item.amount) !== 0)
    .slice()
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  if (named.length === 0) return '';

  const money = (n: number) => inProse(formatStatementFigure(n, { scale }));
  // NO AGED REPORT, NO FIRST LEG. Where the pack prints no aged total the
  // headline above is the SUBLEDGER, so there is no report-to-subledger step
  // to bridge and a clause inventing one would put a figure on the page that
  // no sheet states.
  const unageable = read.agedDebtorsTotal === null
    ? 0
    : round2(subledgerTotal - read.agedDebtorsTotal);
  // The first leg is printed only where it is not nil: on a company whose
  // every document carries a due date the report total IS the subledger
  // total, and a clause explaining a difference of nothing is the noise this
  // page can least afford.
  const legOne = Math.round(unageable / MONEY_SCALES[scale]) === 0
    ? (read.agedDebtorsTotal === null
      ? ''
      : ` The report ages the whole of an open customer subledger of ${money(subledgerTotal)}.`)
    : ` The report ages ${money(read.agedDebtorsTotal ?? 0)} of an open customer subledger of `
      // "the 19 between them documents with no due date" has no verb — the
      // reading meant is that the 19 IS documents of that kind. Six
      // characters, and the clause parses.
      + `${money(subledgerTotal)}, the ${money(unageable)} between them being documents with no `
      + 'due date, which reach no aging bucket.';

  // "4 175 open documents carrying no link to a journal entry" reads as a
  // COUNT of documents, and the first draft printed exactly that. The amount
  // and the population are two different facts and the row is worth more
  // stating both: `documentIds` is the population the service itemised the
  // amount from, so "4 175 across 29 open documents" is one figure a reader
  // can check against page 11's own arithmetic and one they can hand to
  // whoever has to clear them.
  const clauses = named.map((item) => {
    const population = item.documentIds.length;
    // Grouped like every other figure on the sheet: "across 1 012", not "1012".
    const across = population === 0 ? '' : ` across ${formatStatementFigure(population, { pack: true })}`;
    // A BRACKETED FIGURE NEVER OPENS A CLAUSE: "…, (2) across 14 open
    // documents" read as item (2) of a numbered list.
    const amount = money(item.amount);
    const lead = amount.startsWith('(') ? `a difference of ${amount}` : amount;
    return `${lead}${across} ${ITEM_CLAUSE[item.type]!}`;
  });
  const list = clauses.length === 1
    ? clauses[0]!
    : `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]!}`;
  // THE DIFFERENCE IS NOT PRINTED AS A FIGURE, AND THAT IS THE ROUNDING TRAP
  // RATHER THAN A SHORTENING.
  //
  // It read "Of the 4 494 between that subledger and the control account,
  // 4 175 … and 320 …" — and 4 175 + 320 is 4 495. Both are right: the raw
  // components sum to the raw gap exactly (the service closes to nothing
  // unexplained), and 4 174 721.50 and 319 700 each round UP while
  // 4 494 421.50 rounds down. A stated total its own components do not reach
  // is the one thing this sheet exists to not do.
  //
  // Printing no total makes every relation on the block close on its face:
  // the headline is 4 146 against (330), a difference of 4 476 — exact; the
  // first leg is 4 146 plus 19 into a subledger of 4 165 — exact; and a
  // reader taking 4 165 against (330) gets 4 495, which is what the two
  // components add to. The alternative was a rounding footnote on the one
  // page in the pack whose paper is measured in matters rows, to explain a
  // discrepancy that need not be printed at all.
  // AND THAT THEY CLOSE IT, which is the point of listing them and the one
  // thing the block did not say. On Brightsphere the two documented
  // categories ARE the whole difference; a reader was given a list of parts
  // and left to wonder whether it was all of them, which turns a proof into
  // an inventory.
  //
  // NO NEW FIGURE. "4 175 and 320 make 4 495" would put a second total beside
  // the headline's 4 476 and invite exactly the rounding question the
  // paragraph above avoids printing a total to escape.
  //
  // AND IT IS CONDITIONAL ON THERE BEING NOTHING LEFT OVER.
  // `unexplained_difference` is one of the service's own reconciling types
  // and gets a clause like any other — "left over, which this reconciliation
  // could not account for". A list that includes it still sums to the
  // difference, so "they account for all of it" would be arithmetically true
  // and would tell a director the opposite of what that clause says.
  //
  // AND IT IS THE SERVICE'S OWN RESIDUAL THAT DECIDES, NOT A PROXY FOR IT.
  // `read.unexplained` is `reconcileSubledger`'s `unexplainedDifference` —
  // the authoritative leftover — and it was loaded into the read, given a
  // docblock, and never looked at, while the closure claim was re-derived
  // from the presence of an `unexplained_difference` ITEM.
  //
  // Both, and the item test stays for the null residual: a service that
  // could not read a subledger reports no residual at all, and a claim of
  // closure must not be reachable by a figure being absent.
  const closes = round2(read.unexplained ?? 0) === 0
    && named.every((item) => item.type !== 'unexplained_difference');
  // AND THE CLAIM SAYS WHICH PRECISION IT IS TRUE AT.
  //
  // On the demo the printed split is 10 665 + 2 + (1) = 10 666 against a
  // stated difference of 10 665 — inside the rounding this pack declares, and
  // page 12 says so in general, but the sentence beside it makes an explicit
  // CLOSURE claim on its own face and a closure claim that does not close by
  // one is a different thing from a page without a pointer. Three words,
  // where a footnote would have cost this sheet a matters row.
  const closure = !closes ? ''
    : ` ${named.length === 1 ? 'That accounts' : 'Together they account'} for all of it, `
      + 'before rounding.';
  return `${legOne} Between that subledger and the trade-receivable control account in the `
    + `general ledger: ${list}.${closure}`;
}
