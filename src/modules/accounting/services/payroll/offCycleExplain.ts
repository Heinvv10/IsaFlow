/**
 * "How was this calculated?" for an off-cycle line's month (wave 6 OC; payrollOffCycleMonth.ts has the rules). The UIF
 * and ETI explanations are built for the line as if alone (UIF) and for the whole month (ETI); these steps then take
 * off what the month's earlier lines already contributed or claimed. Arranges the engine's figures; computes none.
 */
import type { FigureExplanation } from './payrollExplainTypes';
import type { MonthEarlierLines } from './payrollOffCycleMonth';
import type { UifResult } from './payrollTypes';

export interface OffCycleExplainInput {
  earlier: MonthEarlierLines;
  /** The cap's room left after the earlier lines (null: no UIF on this line). */
  uifRoom: { employee: number; employer: number } | null;
  /** The month's ETI on everything the month paid, before the earlier lines' claim comes off. */
  monthEti: number;
}

const UIF_SOURCE = { label: 'UIC Act 4 of 2002 s6(1)-(2): 1% of the remuneration paid during the month, not above the ceiling' };
const ETI_SOURCE = { label: 'Employment Tax Incentive Act 26 of 2013 s7: a monthly amount on the monthly remuneration' };

export function explainOffCycleUif(uif: FigureExplanation, input: OffCycleExplainInput, line: UifResult): FigureExplanation {
  if (input.uifRoom === null) return uif;
  return {
    ...uif,
    result: line.employeeContribution,
    steps: [
      ...uif.steps,
      { key: 'uif.month.earlier', label: 'UIF the month\'s earlier runs already took (employee)', amount: input.earlier.uifEmployee, source: UIF_SOURCE },
      { key: 'uif.month.room', label: 'Room left under the month\'s ceiling', amount: input.uifRoom.employee, formula: '1% × the monthly ceiling, less the earlier runs\' UIF, not below nil' },
      { key: 'uif.month.line', label: 'UIF on this run (employee; the employer\'s likewise)', amount: line.employeeContribution, formula: 'the lesser of this run\'s contribution and the room left' },
    ],
  };
}

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
