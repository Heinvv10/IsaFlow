/**
 * Whether the page a trend panel points at prints a comparative figure for
 * it, read off the composed tables and scorecard. Lifted out of
 * `buildBoardPackPages` whole for the 300-line cap: the statements below are
 * the composer's own, unchanged, and it calls this where they stood.
 */
import type { PackScorecardGroup, PackTable } from './packPageModel';

export function comparativeReader(
  income: PackTable,
  cash: PackTable,
  scorecard: PackScorecardGroup[],
): (panelId: string) => boolean {
  // WHICH DESTINATION CELLS ACTUALLY CARRY A COMPARATIVE, read off the tables
  // and the scorecard this pack composed rather than off the figure set they
  // came from. Page 10's note claims "all against the comparative but gross
  // margin", and the demo pack's page 9 prints Debtor days PRIOR as `n/m` —
  // the same state as gross margin's, and one the sentence did not name.
  //
  // A `PackFigure` whose `value` is null is a cell printing a reason instead
  // of a number, which is exactly what "prints no comparative" means to a
  // reader who turns to it.
  //
  // AND A CELL THAT IS NOT THERE PRINTS NONE EITHER. This read
  // `row?.figures.prior?.value !== null`, and on a pack with no comparative
  // period the row carries no `prior` figure at all: `undefined !== null` is
  // true, so four absent columns were reported as four comparatives.
  const rowPrior = (table: PackTable, label: string): boolean => {
    const prior = table.rows.find((r) => r.label.toLowerCase() === label)?.figures.prior;
    return prior !== undefined && prior.value !== null;
  };
  const printsComparative = (panelId: string): boolean => {
    switch (panelId) {
      case 'trend-revenue': return rowPrior(income, 'revenue');
      case 'trend-operating-expenses': return rowPrior(income, 'operating expenses');
      case 'trend-net-profit': return rowPrior(income, 'net profit');
      case 'trend-cash': return rowPrior(cash, 'closing cash');
      case 'trend-debtor-days':
        return scorecard.some((g) => g.rows.some(
          // `prior` is NULL, not undefined, where there is no prior period —
          // the same trap as `rowPrior` above, one arm down.
          (r) => r.metric.toLowerCase() === 'debtor days' && r.prior !== null && r.prior.value !== null,
        ));
      // Gross margin's exception is structural — page 6 carries no comparative
      // column for the ratio at all — and `printsAgainstComparative` already
      // states it, so this reading cannot make it worse or better.
      default: return true;
    }
  };
  return printsComparative;
}
