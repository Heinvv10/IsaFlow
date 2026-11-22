/**
 * A line's UIF (moved out of payrollCalculator to keep it under the file cap; behaviour unchanged). UIF is on the room
 * left under the month's ceiling after the month's earlier runs (UIC Act s6(1)(a), s6(2)): a weekly or fortnightly
 * line's earlier runs of its frequency (FQc), or an off-cycle line's earlier final runs (OC, payrollOffCycleMonth). An
 * off-cycle line takes the month's liability rounded once, less what the earlier lines booked (offCycleUif, review
 * #1679). A line outside UIF (excluded, or its tax status) takes none.
 */
import { uifWithLeviable } from './uifEngine';
import { offCycleUif, type MonthEarlierLines } from './payrollOffCycleMonth';
import type { UifResult } from './payrollTypes';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function costLineUif(args: {
  outside: boolean; leviable: number; taxYear: number; cadenceMonthToDate: number; monthEarlier?: MonthEarlierLines;
}) {
  const monthToDate = round2(args.cadenceMonthToDate + (args.monthEarlier?.uifRemuneration ?? 0));
  const month = args.outside || !args.monthEarlier ? null : offCycleUif(args.leviable, args.monthEarlier, args.taxYear);
  const costed = args.outside ? null : month ?? uifWithLeviable(args.leviable, args.taxYear, monthToDate);
  const uif: UifResult = costed?.uif ?? { employeeContribution: 0, employerContribution: 0, isCapped: false };
  return { monthToDate, month, costed, uif };
}
