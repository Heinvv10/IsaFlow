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
  /** The residual the service could not account for. */
  unexplained: number | null;
}

/**
 * ONE CLAUSE PER RECONCILING TYPE, written for a director.
 *
 * A `Record` over the closed set rather than the service's own
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
  // The residual carries no population, so `across N` is suppressed for it
  // by `documentIds` being empty — which is the service's own shape, not a
  // special case written here.
  unexplained_difference: 'left over, which this reconciliation could not account for',
};

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
function decomposition(
  read: PackReceivablesRead,
  tradeReceivables: number,
  scale: MoneyScale,
): string {
  const { subledgerTotal, controlBalance, items } = read;
  if (subledgerTotal === null || controlBalance === null) return '';
  // The guard: two readings of one balance must agree to the cent before the
  // items are allowed to describe the difference between them.
  if (round2(controlBalance) !== round2(tradeReceivables)) return '';

  const named = items
    .filter((item) => ITEM_CLAUSE[item.type] !== undefined && round2(item.amount) !== 0)
    .slice()
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  if (named.length === 0) return '';

  const money = (n: number) => inProse(formatMoney(n, { scale }));
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
      + `${money(subledgerTotal)}, the ${money(unageable)} between them documents with no due `
      + 'date, which reach no aging bucket.';

  // "4 175 open documents carrying no link to a journal entry" reads as a
  // COUNT of documents, and the first draft printed exactly that. The amount
  // and the population are two different facts and the row is worth more
  // stating both: `documentIds` is the population the service itemised the
  // amount from, so "4 175 across 29 open documents" is one figure a reader
  // can check against page 11's own arithmetic and one they can hand to
  // whoever has to clear them.
  const clauses = named.map((item) => {
    const population = item.documentIds.length;
    const across = population === 0 ? '' : ` across ${population}`;
    return `${money(item.amount)}${across} ${ITEM_CLAUSE[item.type]!}`;
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
  const closes = named.every((item) => item.type !== 'unexplained_difference');
  const closure = !closes ? ''
    : ` ${named.length === 1 ? 'That accounts' : 'Together they account'} for all of it.`;
  return `${legOne} Between that subledger and the trade-receivable control account in the `
    + `general ledger: ${list}.${closure}`;
}

/** The heading page 4's debtors-base disclosure prints under. */
export const RECEIVABLES_BASE_HEADING = 'What debtor days is measured on';

/**
 * THE RATIO WAS ARITHMETICALLY CORRECT AND ECONOMICALLY MEANINGLESS, AND THE
 * PACK SAID NOTHING.
 *
 * Page 7's memorandum prints trade receivables of 59 on the live demo pack
 * and pages 3 and 9 derive debtor days of 213 from it — 59 over 101 times
 * 365, a division a director can take off the paper and a figure they can
 * act on. That 59 is the trade-receivable CONTROL ACCOUNT, and the open
 * subledger for the same company on the same date is 10 724: the ratio is
 * computed on a base holding half a per cent of what the books say customers
 * owe. Nothing in twelve sheets said which of the two numbers "trade
 * receivables" meant.
 *
 * This is the debtors defect one step downstream, and it is the more
 * dangerous half: page 11's contradiction is at least VISIBLE — two figures
 * on facing sheets — while 213 days looks like an ordinary measurement and
 * reads as one.
 *
 * IT DISCLOSES THE BASE AND DOES NOT REPRICE THE RATIO. Recomputing debtor
 * days off the subledger would change a printed figure on a judgement about
 * which balance is the right numerator, and that judgement is not a
 * rendering decision. The pack states what the number is measured on and
 * what the other reading would be; the choice stays with the people whose
 * books these are.
 *
 * IT IS ON PAGE 4, and that was measured rather than preferred. Page 7 is
 * where the memorandum sits and where this belongs, and it has 1.93mm on the
 * live demo company against a 3.88mm line — no room for a word, let alone a
 * block. Pages 3, 9 and 12 are 1.65, 1.71 and 2.59 on their tightest
 * fixtures. Page 4 is prose by specification, is the first sheet a board
 * reads, and has 85.86mm spare on the demo and 49.87 on Brightsphere after
 * the ledger-currency note. A caveat about how to read a ratio printed on
 * two later sheets is the same class of thing as the ledger-currency note
 * beside it: how much of reality these figures capture.
 *
 * IT IS SILENT WHERE THE SCORECARD STATES NO DAY COUNT. Brightsphere's
 * revenue is not a positive base and its scorecard prints a reason in place
 * of debtor days, so there is no ratio to qualify — the same condition
 * `packTradeBalances.dayCountsMeasured` already governs its own pointer by,
 * read through that function rather than judged again here. And it is silent
 * where the two readings agree at the pack's scale, which is a company whose
 * subledger and control account reconcile.
 *
 * @param debtorDaysMeasured Whether the scorecard states debtor days as a
 *   number — `dayCountsMeasured(set) === 'both' | 'debtorOnly'`.
 */
export function receivablesBaseNote(
  read: PackReceivablesRead,
  tradeReceivables: number,
  scale: MoneyScale,
  debtorDaysMeasured: boolean,
): PackPageBlock | null {
  if (!debtorDaysMeasured) return null;
  const { subledgerTotal } = read;
  if (subledgerTotal === null) return null;
  if (Math.round(round2(subledgerTotal - tradeReceivables) / MONEY_SCALES[scale]) === 0) return null;

  const money = (n: number) => inProse(formatMoney(n, { scale }));
  // THE POINTER EXISTS ONLY WHERE THE PAGE IT POINTS AT CARRIES THE THING.
  //
  // This note fires wherever debtor days is measured and the two readings
  // differ; page 11's reconciliation fires only where a sheet PRINTS an aged
  // debtors total. On the demo those two conditions come apart: page 4 said
  // "the matters page sets out what the difference consists of" and the demo's
  // matters page carries no such section, because its largest debtor is under
  // the concentration threshold and no aged total is printed anywhere. A
  // pointer to a page that does not carry the thing is the defect a director
  // catches live in the meeting, and it was introduced by two correct rulings
  // meeting each other.
  //
  // Narrowed rather than reversed: the clause is redundant on the demo anyway,
  // because this note states BOTH figures itself. Where page 11 does carry the
  // reconciliation — Brightsphere — the pointer is worth having and prints.
  // AND THE CONDITION IS PAGE 11'S OWN, ASKED OF PAGE 11. It used to be
  // `agedDebtorsTotal === null`, which was the reconciliation's gate at the
  // time and stopped being it the moment that block learned to fire on the
  // subledger. Two copies of one condition is how a pointer comes to name a
  // page that carries nothing; this asks the builder.
  const pointer = receivablesReconciliationNote(read, tradeReceivables, scale) === null
    ? ''
    : ' — the matters page sets out what the difference consists of —';
  return mustDisclose(RECEIVABLES_BASE_HEADING, [
    note('The base',
      inScale(
        'Debtor days on the highlights and scorecard pages is taken on trade receivables of '
        + `${money(tradeReceivables)}, the trade-receivable control account in the general `
        + `ledger and the figure the balance sheet states. The open customer subledger for the `
        + `same date is ${money(subledgerTotal)}`,
        scale,
      )
      + `. The two are not reconciled${pointer} and this pack does not recompute the ratio on `
      + 'the other base. Read the day count as a measure of the control account, not of what '
      + 'customers owe.'),
  ]);
}
