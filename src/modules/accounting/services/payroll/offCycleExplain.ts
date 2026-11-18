/**
 * "How was this calculated?" for an off-cycle line's ETI (wave 6 OC; payrollOffCycleMonth.ts has the rules). The ETI
 * explanation is built for the whole month; these steps then take off what the month's earlier lines already claimed.
 * (The line's UIF needs no step of its own: statutoryExplain shows the month's earlier remuneration, uif.monthToDate.)
 * Arranges the engine's figures; computes none.
 */
import type { FigureExplanation } from './payrollExplainTypes';
import type { MonthEarlierLines } from './payrollOffCycleMonth';

export interface OffCycleExplainInput {
  earlier: MonthEarlierLines;
  /** The month's ETI on everything the month paid, before the earlier lines' claim comes off. */
  monthEti: number;
}

const ETI_SOURCE = { label: 'Employment Tax Incentive Act 26 of 2013 s7: a monthly amount on the monthly remuneration' };

export function explainOffCycleEti(eti: FigureExplanation, input: OffCycleExplainInput, lineEti: number): FigureExplanation {
  return {
    ...eti,
    result: lineEti,
    resultLabel: 'ETI on this run (the month\'s, less the earlier runs\'; negative reverses an over-claim)',
    steps: [
      ...eti.steps,
      { key: 'eti.month.total', label: 'ETI for the month, on everything the month paid', amount: input.monthEti, source: ETI_SOURCE },
      { key: 'eti.month.earlier', label: 'ETI the month\'s earlier runs already claimed', amount: input.earlier.eti },
      { key: 'eti.month.line', label: 'ETI on this run', amount: lineEti, formula: 'the month\'s ETI less the earlier runs\'' },
    ],
  };
}
