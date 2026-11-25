/**
 * W29 (wave 7 PRA; Hein rulings 7, 13, 19): a recurring earning that starts or ends strictly inside employment, inside
 * the run's period, is paid for the part of the period it ran. Pure; the run (payrollRunComponents) and the oracle apply
 * it to the rows they read, before the fringe and percent-of-RFI steps, so a fund contribution costed on RFI sees the
 * apportioned pay, and the loan preview and the stored line cost the same components.
 *
 * Basis (ruling 13): monthly = WORKING days (Monday to Friday) of the month, employedShareOfMonth (employmentTerms), over
 * the row's window inside employment; weekly / fortnightly = CALENDAR days of the period, periodShareOf
 * (payFrequencyPeriods: G21 (2027) Rev 1 p. 9-10 prints a part period as its share of days, "3 of 7 days = 0.4285").
 * SARS prescribes no basis for apportioning pay itself (G21 p. 9-10 is the annual equivalent of part-period pay): the basis
 * is Hein's ruling 13, and the tax on the apportioned pay follows the engine as it is.
 *
 * Scope (ruling 19): only a row whose start is after both the period's first day and the employee's start, or whose end is
 * before both the period's last day and the employee's end (no end date: employed past the period). A starter's own rows
 * (starting on their start date) and a leaver's own rows (ending on their end date) keep today's pay: full month. Only a
 * recurring EARNING with a plain amount is apportioned; hours / days rows (quantity), percent-of-RFI and defined-benefit
 * rows are not (their amount is costed from other inputs), and nor is a deduction: the pro-rata guard still flags those.
 *
 * A window with no working day (a raise starting on the month's last weekend) pays 0, not employedShareOfMonth's one-day
 * floor (which keeps a starter from counting as not employed): the floor would pay the month's days twice across a raise.
 */
import { employedShareOfMonth } from './employmentTerms';
import { dayNumber, isoOfDate, periodShareOf } from './payFrequencyPeriods';
import type { EmployeeComponent, PayFrequency, PayrollPeriod, RecurringShare, UnsupportedValue, ValidationResult } from './payrollTypes';

export interface ShareRow { effectiveFrom: string; effectiveTo: string | null }
export interface ShareEmployee { startDate: Date; endDate?: Date | null }

const round2 = (n: number): number => Math.round(n * 100) / 100;
const pad = (n: number): string => String(n).padStart(2, '0');

/** The period's first and last day: a weekly / fortnightly run's own dates, else the calendar month. */
export function periodBoundsOf(period: PayrollPeriod): { start: string; end: string } {
  if (period.start && period.end) return { start: period.start, end: period.end };
  const last = new Date(period.year, period.month, 0).getDate();
  return { start: `${period.year}-${pad(period.month)}-01`, end: `${period.year}-${pad(period.month)}-${pad(last)}` };
}

/** The row starts or ends strictly inside employment, inside the period (ruling 19). */
export function insideEmploymentEdge(period: PayrollPeriod, row: ShareRow, employee: ShareEmployee): boolean {
  const { start, end } = periodBoundsOf(period);
  const employedFrom = isoOfDate(employee.startDate);
  const employedTo = employee.endDate ? isoOfDate(employee.endDate) : null;
  // A row starting after the employee's last day is not inside employment: it keeps today's pay (ruling 19's scope).
  const startsInside = row.effectiveFrom > start && row.effectiveFrom <= end && row.effectiveFrom > employedFrom
    && (employedTo == null || row.effectiveFrom <= employedTo);
  const endsInside = row.effectiveTo != null && row.effectiveTo >= start && row.effectiveTo < end
    && (employedTo == null || row.effectiveTo < employedTo);
  return startsInside || endsInside;
}

/** Monday to Friday days from `from` to `to`, inclusive (public holidays not excluded, as employedShareOfMonth). */
function workingDays(from: string, to: string): number {
  let n = 0;
  for (let d = dayNumber(from); d <= dayNumber(to); d += 1) {
    const weekday = new Date(d * 86_400_000).getUTCDay();
    if (weekday !== 0 && weekday !== 6) n += 1;
  }
  return n;
}

const localDate = (iso: string): Date => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const utcDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

/** The share of the period the row paid, or null when ruling 19 leaves it whole. */
export function recurringShareOf(
  frequency: PayFrequency | UnsupportedValue, period: PayrollPeriod, row: ShareRow, employee: ShareEmployee,
): Omit<RecurringShare, 'fullAmount'> | null {
  if (!insideEmploymentEdge(period, row, employee)) return null;
  const { start, end } = periodBoundsOf(period);
  const employedTo = employee.endDate ? isoOfDate(employee.endDate) : end;
  const from = [start, row.effectiveFrom, isoOfDate(employee.startDate)].reduce((a, b) => (a > b ? a : b));
  const to = [end, row.effectiveTo ?? end, employedTo].reduce((a, b) => (a < b ? a : b));
  const calendar = (frequency === 'weekly' || frequency === 'fortnightly') && period.start != null && period.end != null;
  if (calendar) {
    const days = to < from ? 0 : dayNumber(to) - dayNumber(from) + 1;
    const share = days === 0 ? 0 : periodShareOf(frequency, period, utcDate(from), utcDate(to));
    return { share, days, of: dayNumber(end) - dayNumber(start) + 1, basis: 'calendar_days' };
  }
  const days = to < from ? 0 : workingDays(from, to);
  const share = days === 0 ? 0 : employedShareOfMonth({ year: Number(start.slice(0, 4)), month: Number(start.slice(5, 7)) }, localDate(from), localDate(to));
  return { share, days, of: workingDays(start, end), basis: 'working_days' };
}

/** A row this release apportions: a recurring earning with a plain amount and its dates read. */
export function isApportionable(c: Pick<EmployeeComponent, 'isRecurring' | 'quantity' | 'percentOfRfi' | 'dbMemberCategoryFactor'>
  & { component: { componentType: string } }): boolean {
  return c.isRecurring === true && c.component.componentType === 'earning'
    && c.quantity == null && c.percentOfRfi == null && c.dbMemberCategoryFactor == null;
}

/** Each apportionable row read with its dates, at its share of the period (others unchanged). */
export function apportionRecurringRows(
  components: EmployeeComponent[], employee: ShareEmployee & { payFrequency: PayFrequency | UnsupportedValue }, period: PayrollPeriod,
): EmployeeComponent[] {
  return components.map((c) => {
    if (!isApportionable(c) || c.effectiveFrom === undefined) return c;
    const share = recurringShareOf(employee.payFrequency, period, { effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo ?? null }, employee);
    if (!share) return c;
    return { ...c, amount: round2(c.amount * share.share), share: { ...share, fullAmount: c.amount } };
  });
}

/** "9 of 22 working days (0.4090)": the share as the payslip line prints it (truncated to four decimals, as G21 p. 10). */
export function describeShare(share: Pick<RecurringShare, 'share' | 'days' | 'of' | 'basis'>): string {
  const four = (Math.floor(share.share * 10_000) / 10_000).toFixed(4);
  return `${share.days} of ${share.of} ${share.basis === 'working_days' ? 'working' : 'calendar'} days (${four})`;
}

export const SHARE_BESIDE_ONCE_OFF = 'RECURRING_SHARE_BESIDE_ONCE_OFF';

/**
 * Before W29 the pro-rata guard told employers to end a part-month row and pay its days as a once-off. Such a row is now
 * paid its share, so a once-off of the same component in the period may pay those days twice. The run cannot tell a
 * hand pro-rata from a genuine extra payment, so it warns (not blocking) on the line, naming both.
 */
export function shareBesideOnceOffWarnings(components: readonly EmployeeComponent[]): ValidationResult[] {
  const onceOff = new Set(components.filter((c) => c.isRecurring === false).map((c) => c.component.id));
  return components.filter((c) => c.share && onceOff.has(c.component.id)).map((c) => ({
    code: SHARE_BESIDE_ONCE_OFF, severity: 'warning' as const, field: 'components',
    message: `${c.component.name} ran for part of this period and is paid its share (${describeShare(c.share!)}), and a once-off of `
      + `${c.component.name} is paid in the same period. If that once-off was entered by hand to pro-rate the same days, they are paid `
      + 'twice: end or reduce the once-off, then recalculate.',
  }));
}

