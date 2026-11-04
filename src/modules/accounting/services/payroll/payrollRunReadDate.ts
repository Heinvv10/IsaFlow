import type { PayrollPeriod } from './payrollTypes';

const pad2 = (n: number) => String(n).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * The calendar day a pay run reads its employees' components on: the LAST day of its period, as 'YYYY-MM-DD'.
 *
 * Built as a plain string, never through a Date: the run used to build `new Date(year, month - 1, 28)` at local
 * midnight and the reader rendered it with toISOString(), so on the SAST host every run read as at the 27th.
 *
 * The last day, not the 28th: a once-off is stored from its own date to its own month end (payrollBatchService,
 * assignComponentToEmployee, applyPackageToEmployee), so only the month end is inside every once-off of the month.
 * It is one day for recurring rows too: a supersede leaves contiguous windows on one component, and reading two rows
 * of a pair on different days pays both or neither.
 */
export function payrollRunReadDate(period: PayrollPeriod): string {
  return `${period.year}-${pad2(period.month)}-${pad2(daysInMonth(period.year, period.month))}`;
}
