/**
 * Page 4's debtors-base disclosure — what debtor days is measured on. Moved
 * out of `packReceivablesReconciliation.ts` unchanged to keep that file under
 * the 300-line cap; `packReceivablesReconciliation.ts` re-exports both names,
 * so existing import paths still resolve.
 */
import { formatMoney, inProse, inScale, MONEY_SCALES, type MoneyScale } from '@/lib/format/money';
import { round2 } from '@/modules/accounting/services/reconciliation/reconciliationMath';
import { mustDisclose, note } from './packPageBlocks';
import type { PackPageBlock } from './packPageModel';
import type { PackReceivablesRead } from './packReceivablesReconciliation';

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
  /** Page 11's block, from `receivablesReconciliationNote` on the SAME read —
   *  the builder's own answer, handed in rather than asked for a second time.
   *  It was built up to four times per pack purely to test it for null. */
  reconciliation: PackPageBlock | null,
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
  const pointer = reconciliation === null
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
