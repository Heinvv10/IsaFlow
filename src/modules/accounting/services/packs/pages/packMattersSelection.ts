/**
 * Page 11's support blocks, its headline, and the one selection of matters
 * pages 4 and 11 both read. Lifted out of `buildBoardPackPages` whole for the
 * 300-line cap: the statements below are the composer's own, unchanged and in
 * their own order, and it calls this where they stood.
 */
import type { MoneyScale } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { withDerivedMatters } from './packDerivedMatters';
import { selectPrintedMatters, type SelectedMatters } from './packMattersPrinted';
import {
  buildMattersSupportBlocks,
  mattersBudgetMm,
  mattersTitle,
} from './packMattersPage';
import { pending } from './packNarrativePage';
import type { receivablesReconciliationNote } from './packReceivablesReconciliation';
import type { BoardPackInput } from './packBoardPackInput';

export function selectBoardPackMatters(
  input: BoardPackInput,
  receivablesReconciliation: ReturnType<typeof receivablesReconciliationNote>,
  trend: PackTrendPoint[],
  scale: MoneyScale,
  set: PackFigureSet,
): {
  mattersSupport: ReturnType<typeof buildMattersSupportBlocks>;
  mattersHeadline: string;
  matters: SelectedMatters;
} {
  // PAGE 11'S OWN BLOCKS, BEFORE ITS TABLE — because the table's budget is
  // whatever they leave behind. ONE selection, read by page 4's panel and
  // page 11's table alike: derived twice, they contradicted each other. See
  // `SelectedMatters` and `mattersBudgetMm`.
  // PAGE 11 CARRIES THE RECONCILIATION OF THE TWO DEBTORS FIGURES THE PACK
  // PRINTS, and it is a SUPPORT block rather than something appended after
  // the table, because this page's table is budgeted against whatever its
  // support blocks leave behind — see `packReceivablesReconciliation.ts` for
  // what that costs and why it is the right way round.
  const mattersSupport = buildMattersSupportBlocks(
    input.mattersCommentary ?? pending,
    receivablesReconciliation,
  );
  // The title first, from the FULL list: the budget the table spends depends
  // on how much paper the header leaves, and the headline must not change
  // when a row moves off the page.
  // The checks that reach this page all read the ledger; one anomaly is
  // visible only in the SERIES — see `creditMonthMatters`.
  // THE PERIOD'S NET PROFIT IS AN ARGUMENT, not a fact the derived sentence
  // infers from the branch it is written in — see `CREDIT_MONTH_STANDING`.
  const allMatters = withDerivedMatters(input.matters, trend, scale, set.current.netProfit);
  const mattersHeadline = mattersTitle(allMatters, scale);
  const matters = selectPrintedMatters(
    allMatters, mattersBudgetMm(mattersSupport, mattersHeadline, allMatters),
  );
  return { mattersSupport, mattersHeadline, matters };
}
