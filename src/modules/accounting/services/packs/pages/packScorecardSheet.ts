/**
 * Page 9 and the three readings it shares with other sheets — the
 * receivables reconciliation, the debtors-base note and page 7's impossible
 * balances. Lifted out of `buildBoardPackPages` whole for the 300-line cap:
 * the statements below are the composer's own, unchanged and in their own
 * order, and it calls this where they stood.
 */
import type { scorecardScore } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import type { MoneyScale } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { dayCountsMeasured } from './packTradeBalances';
import { impossibleBalanceLines, type ImpossibleBalanceLine } from './packPageBlocks';
import { buildScorecardPage, scorecardPageNotes } from './packScorecardNotes';
import {
  receivablesBaseNote,
  receivablesReconciliationNote,
} from './packReceivablesReconciliation';
import type { BoardPackInput } from './packBoardPackInput';
import type { UnnumberedPage } from './packFrontMatter';
import type {
  PackChartSpec,
  PackComparativePeriod,
  PackScorecardGroup,
  PackTable,
} from './packPageModel';

export function buildScorecardSheet(
  input: BoardPackInput,
  set: PackFigureSet,
  scale: MoneyScale,
  position: PackTable,
  scorecard: PackScorecardGroup[],
  score: ReturnType<typeof scorecardScore>,
  panels: PackChartSpec[],
  comparativePeriod: PackComparativePeriod | null,
): {
  receivablesReconciliation: ReturnType<typeof receivablesReconciliationNote>;
  debtorsBase: ReturnType<typeof receivablesBaseNote>;
  page7Impossible: ImpossibleBalanceLine[];
  scorecardPage: UnnumberedPage;
} {
  // PAGE 9'S ONE FOOTNOTE MARKS THE ROW IT IS ABOUT. `PackScorecardRow.footnote`
  // is rendered by `ScorecardTable` and has been since the row model was
  // written; the page simply never set it, so "Debtor days on this page … is
  // the figure for the WHOLE reporting period" printed under a Debtor days
  // row with nothing on it. Set only where the footnote is actually printed —
  // the panel it reciprocates is not drawn on every pack.
  // AND THE ROW THAT CARRIES A RED MISS CARRIES THE BASE CAVEAT WITH IT.
  //
  // Page 9 prints `Debtor days · 213 days · target 30 days · MISSED` in red,
  // and page 4 says the ratio is taken on trade receivables of 59 — the
  // control account — against an open customer subledger of 10 724, and to
  // "read the day count as a measure of the control account, not of what
  // customers owe". The pack scored a red miss against a base it disowns one
  // page earlier, and this row's only footnote was about annualisation. The
  // cross-reference ran one way.
  //
  // Fired on the SAME condition page 4's block is, by asking that builder, so
  // the two cannot come apart; and carried inside the existing footnote,
  // because sheet 9 has 2.77mm and a second one costs 3.88.
  // BUILT ONCE FOR THE WHOLE PACK. Page 4's block, page 9's flag and page
  // 11's own support block all turn on these two, and they were composed up
  // to four times between them purely to be tested for null.
  const receivablesReconciliation = receivablesReconciliationNote(
    input.receivables, set.current.accountsReceivable, scale,
  );
  const debtorsBase = receivablesBaseNote(
    input.receivables,
    set.current.accountsReceivable,
    scale,
    ['both', 'debtorOnly'].includes(dayCountsMeasured(set)),
    receivablesReconciliation,
  );
  const debtorsBaseApplies = debtorsBase !== null;
  // PAGE 9'S FOOTNOTES AND THE MARKERS THAT POINT AT THEM — see
  // `packScorecardNotes`. Three separate rulings' worth of reasoning, all
  // about one sheet's two footnotes, lifted out of the composer whole.
  const page7Impossible = impossibleBalanceLines(position, set);
  const scorecardNotes = scorecardPageNotes({
    scorecard, set, panels, comparativePeriod, debtorsBaseApplies, page7Impossible,
  });
  const scorecardPage = buildScorecardPage(score, scorecard, scorecardNotes);
  return { receivablesReconciliation, debtorsBase, page7Impossible, scorecardPage };
}
