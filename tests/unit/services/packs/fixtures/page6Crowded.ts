/**
 * Page 6 crowded until only one composition fits: the demo with net-debit revenue, two more lines below zero and a 20%
 * unexplained step (both required disclosures), plus a REQUIRED footnote of `sentences` sentences, which the fitter may
 * not take. It stands for whatever else a tenant's page 6 owes the reader: since prose is set at its own widths (the
 * prose PR) the two disclosures cost less, and no shape of `page6Shapes`' 2,560 or `page6Grid`'s 3,840 is refused
 * apart, so none reaches the merge (#1154). Composed by `incomeSheetWithBudget` and fitted as `fitBodyPage` fits it.
 *
 * Without a budget: 2 sentences fit apart, 3 and 4 only merged, 5 are refused. With one: 2 fit apart without the
 * columns, 3 merged with them, 4 merged without them.
 */
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { incomeSheetWithBudget } from '@/modules/accounting/services/packs/pages/packIncomeBudget';
import { fitRelaidPage } from '@/modules/accounting/services/packs/pages/packNarrativeFit';
import { buildIncomeStatementTable } from '@/modules/accounting/services/packs/pages/packStatementTables';
import { page6Input } from './page6Shapes';

export const CROWDING_SENTENCE = 'The prior column is the comparative period the basis page states, and a movement is never '
  + 'shown as a move from zero where that period carries no value for the measure.';

export function crowdedPage6(sentences: number, { budget }: { budget: boolean }) {
  const given = page6Input({ k: 1, negative: true, loss: false, plug: 0.2, sg: [-1, 1, -1, -1] }).set;
  const set = budget ? given : { ...given, budget: null };
  const table = buildIncomeStatementTable(set, new PackFigureProvenance());
  const sheet = incomeSheetWithBudget(table, set, "R'000", [], [{ number: 1, text: CROWDING_SENTENCE.repeat(sentences), required: true }]);
  return fitRelaidPage(sheet).page;
}
