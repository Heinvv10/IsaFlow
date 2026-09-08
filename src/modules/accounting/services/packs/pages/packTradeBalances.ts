/**
 * PAGE 7'S MEMORANDUM ON THE TWO BALANCES THE DAY COUNTS ARE TAKEN ON.
 *
 * THE PACK PRINTED THREE RATIOS WHOSE INPUTS APPEARED ON NO SHEET. Debtor
 * days of 213, creditor days of 789 against a prior 1 035: page 12 gives the
 * formula each is taken by, and trade receivables and trade payables were on
 * none of the twelve sheets, so a director could read *how* the number was
 * made and could not check *that* it was. The balance sheet is seven rows of
 * current/non-current splits and neither balance is one of them. That is the
 * pack's own standard — every claim checkable off the paper — broken in the
 * one place a board reads a figure out loud.
 *
 * IT IS A FOOTNOTE AND NOT TWO ROWS, AND THAT WAS MEASURED. Two memorandum
 * rows cost `TABLE_ROW_MM` twice, 16.30mm; the live demo company's page 7
 * composes at 245.31mm in a 255mm box, so 9.69mm is the whole budget and
 * both of the page's remaining blocks are §3.5 disclosures the pack is
 * required to make. Two lines of 7.5pt cost 7.76 and fit. The figures are
 * the same figures either way; what a footnote gives up is the prior column,
 * which the day counts' own prior is printed against on the scorecard.
 *
 * The pointer is CONDITIONAL on the metric being measurable, because
 * Brightsphere's revenue and cost of sales are not positive bases and its
 * scorecard prints a reason in place of both day counts (`packMetricReads`).
 * A footnote naming a measure the page it points at does not state is the
 * same defect as a page naming a chart the pack does not draw.
 */
import { formatMoney, inProse, inScale, type MoneyScale } from '@/lib/format/money';
import { readCreditorDays, readDebtorDays } from '../figures/packMetricReads';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { toFinancialData } from './packScorecard';
import type { PackFigureSet } from '../figures/packFigureSet';
import type { PackFootnote } from './packPageModel';

/** Which of the two day counts the scorecard states as a number. */
export type DayCountsMeasured = 'both' | 'debtorOnly' | 'creditorOnly' | 'neither';

/**
 * WHERE THE TWO BALANCES ARE USED, one clause per case.
 *
 * A `Record` over the union rather than a chain of `if`s — the
 * `CREDIT_MONTH_STANDING` device — so a case a fixture never reaches is one
 * the author still had to write a sentence for. The `neither` arm points at
 * the reason the scorecard prints rather than at a measure it does not.
 */
const DAY_COUNT_USE: Record<DayCountsMeasured, string> = {
  both: ' They are the numerators of debtor days and creditor days on the scorecard page.',
  debtorOnly: ' Trade receivables is the numerator of debtor days on the scorecard page.',
  creditorOnly: ' Trade payables is the numerator of creditor days on the scorecard page.',
  neither: ' The scorecard page states why neither day count can be measured on these figures.',
};

/** Read through `packMetricReads`, which is the ONE reading of these two
 *  metrics — page 3's tile and page 9's row both go through it, and a second
 *  judgement here is how this footnote comes to disagree with the row it
 *  points at. */
export function dayCountsMeasured(set: PackFigureSet): DayCountsMeasured {
  const ratios = calculateExtendedRatios(toFinancialData(set.current));
  const debtor = readDebtorDays(ratios, set.current).value !== null;
  const creditor = readCreditorDays(ratios, set.current).value !== null;
  if (debtor && creditor) return 'both';
  if (debtor) return 'debtorOnly';
  if (creditor) return 'creditorOnly';
  return 'neither';
}

/**
 * The footnote itself. `inProse` because a nil trade payable is the word and
 * not the money column's dash — Brightsphere carries none — and `inScale`
 * because `R'000` is a column banner everywhere else in this pack and a
 * figure in a sentence has to state its own unit.
 */
export function tradeBalancesFootnote(
  set: PackFigureSet,
  scale: MoneyScale,
  number: number,
): PackFootnote {
  const money = (n: number) => inProse(formatMoney(n, { scale }));
  const balances = `trade receivables are ${money(set.current.accountsReceivable)} and trade `
    + `payables ${money(set.current.accountsPayable)} at the period end`;
  return {
    number,
    text: `Memorandum: ${inScale(balances, scale)}.${DAY_COUNT_USE[dayCountsMeasured(set)]}`,
  };
}
