/**
 * W29 (wave 7 PRA; Hein rulings 7, 13, 19): a recurring earning that starts or ends strictly inside employment, inside
 * the run's period, is paid for the part of the period it ran. Pure; the run (payrollRunComponents) and the oracle apply
 * it to the rows they read, before the fringe and percent-of-RFI steps, so a fund contribution costed on RFI sees the
 * apportioned pay, and the loan preview and the stored line cost the same components.
 *
 * The employed window: the period cut to the employee's employment, [max(period start, start date), min(period end, end
 * date)]. A starter's or leaver's FULL pay is the whole period (ruling 19: their own rows keep full pay), so a row is
 * measured against the employed window, not the calendar period: the rows of one component that split the window sum to
 * its full amount (review #1901 H1: a leaver whose salary changed on the 10th was paid 11/23 of it).
 *
 * Basis (ruling 13): monthly = WORKING days (Monday to Friday), the same ratio employedShareOfMonth (employmentTerms) takes
 * over a whole month; weekly / fortnightly = CALENDAR days, as periodShareOf (payFrequencyPeriods; G21 (2027) Rev 1 p. 9-10
 * prints a part period as its share of days, "3 of 7 days = 0.4285"). The amount is the exact ratio days / of, rounded to
 * the cent once (review H1/M1: each share truncated to four decimals made a split week pay R6 999.30 of R7 000); four
 * decimals are only how the payslip prints it. SARS prescribes no basis for apportioning pay itself (G21 p. 9-10 is the
 * annual equivalent of part-period pay): the basis is Hein's ruling 13; the tax on the apportioned pay is the engine's.
 *
 * Scope (ruling 19): a row whose start is inside the employed window after its first day, or whose end is inside it
 * before its last day. A row on the window's own edges keeps today's pay; so does one wholly outside it (starting after a
 * leaver's last day, ending before a starter's first). Only a recurring EARNING with a plain amount: hours / days rows
 * (quantity), percent-of-RFI and defined-benefit rows are costed from other inputs, and a deduction is not apportioned:
 * the pro-rata guard still flags those. A row whose window has no working day (a raise from the last weekend) pays
 * nothing and is dropped from the line, not given employedShareOfMonth's one-day floor (which would pay those days twice).
 */
import { dayNumber, isoOfDate, isoOfDay as isoOfDayNumber } from './payFrequencyPeriods';
import type { EmployeeComponent, PayFrequency, PayrollPeriod, RecurringShare, UnsupportedValue, ValidationResult } from './payrollTypes';

export interface ShareRow { effectiveFrom: string; effectiveTo: string | null }
export interface ShareEmployee { startDate: Date; endDate?: Date | null }

const round2 = (n: number): number => Math.round(n * 100) / 100;
const pad = (n: number): string => String(n).padStart(2, '0');
const later = (a: string, b: string): string => (a > b ? a : b);
const earlier = (a: string, b: string): string => (a < b ? a : b);

/** The period's first and last day: a weekly / fortnightly run's own dates, else the calendar month. */
export function periodBoundsOf(period: PayrollPeriod): { start: string; end: string } {
  if (period.start && period.end) return { start: period.start, end: period.end };
  const last = new Date(period.year, period.month, 0).getDate();
  return { start: `${period.year}-${pad(period.month)}-01`, end: `${period.year}-${pad(period.month)}-${pad(last)}` };
}

/** A calendar-month period (no run dates of its own): a monthly run's (periodBoundsOf). */
export function isMonthlyPeriod(period: PayrollPeriod): boolean {
  return !(period.start && period.end);
}

/** The period cut to the employee's employment; null when they were not employed in it. */
export function employedWindowOf(period: PayrollPeriod, employee: ShareEmployee): { start: string; end: string } | null {
  const bounds = periodBoundsOf(period);
  const start = later(bounds.start, isoOfDate(employee.startDate));
  const end = employee.endDate ? earlier(bounds.end, isoOfDate(employee.endDate)) : bounds.end;
  return start > end ? null : { start, end };
}

/** The row starts or ends strictly inside the employed window (ruling 19). */
export function insideEmploymentEdge(period: PayrollPeriod, row: ShareRow, employee: ShareEmployee): boolean {
  const w = employedWindowOf(period, employee);
  if (!w) return false;
  const startsInside = row.effectiveFrom > w.start && row.effectiveFrom <= w.end;
  const endsInside = row.effectiveTo != null && row.effectiveTo >= w.start && row.effectiveTo < w.end;
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

/** The share of the employed window the row paid, or null when ruling 19 leaves it whole. */
export function recurringShareOf(
  frequency: PayFrequency | UnsupportedValue, period: PayrollPeriod, row: ShareRow, employee: ShareEmployee,
): Omit<RecurringShare, 'fullAmount'> | null {
  const w = employedWindowOf(period, employee);
  if (!w || !insideEmploymentEdge(period, row, employee)) return null;
  const from = later(w.start, row.effectiveFrom);
  const to = earlier(w.end, row.effectiveTo ?? w.end);
  const calendarDays = (a: string, b: string) => dayNumber(b) - dayNumber(a) + 1;
  // An employed window with no working day (a starter on the month's last Saturday) splits by calendar days instead, so
  // the rows of a pair still sum to the whole (review #1901 R2-L3), never both whole.
  const calendar = ((frequency === 'weekly' || frequency === 'fortnightly') && period.start != null && period.end != null)
    || workingDays(w.start, w.end) === 0;
  const count = calendar ? calendarDays : workingDays;
  const of = count(w.start, w.end);
  const days = to < from ? 0 : count(from, to);
  return { share: days / of, days, of, basis: calendar ? 'calendar_days' : 'working_days' };
}

/** A row this release apportions: a recurring earning with a plain amount and its dates read. */
export function isApportionable(c: Pick<EmployeeComponent, 'isRecurring' | 'quantity' | 'percentOfRfi' | 'dbMemberCategoryFactor'>
  & { component: { componentType: string } }): boolean {
  return c.isRecurring === true && c.component.componentType === 'earning'
    && c.quantity == null && c.percentOfRfi == null && c.dbMemberCategoryFactor == null;
}

/**
 * Each apportionable row read with its dates at its share (others unchanged); a row with no day in the window is dropped.
 * When rows of one component at one amount tile the employed window (their days add up to it: a row re-dated with the
 * same amount, twice or more), the last pays the full amount less the earlier rows, so they foot to the cent (review
 * #1901 R2-L1); rows at different amounts (a raise) are each rounded to the cent.
 */
export function apportionRecurringRows(
  components: EmployeeComponent[], employee: ShareEmployee & { payFrequency: PayFrequency | UnsupportedValue }, period: PayrollPeriod,
): EmployeeComponent[] {
  const out: EmployeeComponent[] = [];
  const tiles = new Map<string, { full: number; days: number; of: number; rounded: number; last: number; same: boolean; spans: Array<[string, string]> }>();
  const window = employedWindowOf(period, employee);
  const lastDay = employee.endDate ? isoOfDate(employee.endDate) : null;
  for (const c of components) {
    // Review #1901 round 3 (coordinator decision): a recurring earning starting after the employee's last day is not paid;
    // the pro-rata guard flags it (edge 'after_end') so approval is refused naming the row.
    if (isApportionable(c) && c.effectiveFrom !== undefined && lastDay != null && c.effectiveFrom > lastDay) continue;
    const share = isApportionable(c) && c.effectiveFrom !== undefined
      ? recurringShareOf(employee.payFrequency, period, { effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo ?? null }, employee)
      : null;
    if (!share) { out.push(c); continue; }
    if (share.days === 0) continue;
    const amount = round2((c.amount * share.days) / share.of);
    const t = tiles.get(c.component.id);
    tiles.set(c.component.id, {
      full: c.amount, days: (t?.days ?? 0) + share.days, of: share.of, rounded: (t?.rounded ?? 0) + amount, last: out.length,
      same: (t?.same ?? true) && (t == null || t.full === c.amount),
      spans: [...(t?.spans ?? []), [later(window!.start, c.effectiveFrom!), earlier(window!.end, c.effectiveTo ?? window!.end)]],
    });
    out.push({ ...c, amount, share: { ...share, fullAmount: c.amount } });
  }
  for (const t of tiles.values()) {
    const diff = round2(t.full - t.rounded);
    if (t.same && t.days === t.of && diff !== 0 && window && tilesWindow(t.spans, window)) out[t.last] = { ...out[t.last]!, amount: round2(out[t.last]!.amount + diff) };
  }
  return out;
}

/** The spans cover the window end to end with no gap and no overlap (review #1901 round 3: an overlap that makes up a gap is not a tiling). */
function tilesWindow(spans: Array<[string, string]>, w: { start: string; end: string }): boolean {
  const sorted = [...spans].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let next = w.start;
  for (const [from, to] of sorted) {
    if (from !== next) return false;
    next = isoOfDayNumber(dayNumber(to) + 1);
  }
  return next === isoOfDayNumber(dayNumber(w.end) + 1);
}

/**
 * The share of a period's employed window a recurring row is paid, as a comparable key ('0', '1' whole, or 'days/of'):
 * the paid-run guard compares it before and after a date change (payrollComponentPaidMonths, review #1901 R2-H1).
 */
export function paidShareOf(
  frequency: PayFrequency | UnsupportedValue, period: PayrollPeriod, row: ShareRow, employee: ShareEmployee,
): string {
  const w = employedWindowOf(period, employee);
  if (!w || (row.effectiveTo != null && row.effectiveTo < row.effectiveFrom)) return '0';
  if (row.effectiveFrom > w.end || (row.effectiveTo != null && row.effectiveTo < w.start)) return '0';
  const share = recurringShareOf(frequency, period, row, employee);
  return share ? `${share.days}/${share.of}` : '1';
}

/** "9 of 22 working days (0.4090)": the share as the payslip line prints it (truncated to four decimals, as G21 p. 10). */
export function describeShare(share: Pick<RecurringShare, 'share' | 'days' | 'of' | 'basis'>): string {
  const four = (Math.floor(share.share * 10_000 + 1e-9) / 10_000).toFixed(4);
  return `${share.days} of ${share.of} ${share.basis === 'working_days' ? 'working' : 'calendar'} days (${four})`;
}

export const SHARE_BESIDE_ONCE_OFF = 'RECURRING_SHARE_BESIDE_ONCE_OFF';

/**
 * Before W29 the pro-rata guard told employers to end a part-month row and pay its days as a once-off; such a row is now
 * paid its share, so a once-off EARNING in the same period may pay those days twice (review #1901 M2). The run cannot tell
 * a hand pro-rata from a genuine extra payment (a bonus in a raise month), so the line records the pair and approval is
 * refused until an owner or admin acknowledges it for this run (payrollRecurringShareAck). `pairKey` names the exact rows
 * and amounts: a change to either side needs a new acknowledgement. Any component, not only the same one.
 */
export function shareBesideOnceOffResults(components: readonly EmployeeComponent[]): ValidationResult[] {
  const shared = components.filter((c) => c.share);
  const onceOff = components.filter((c) => c.isRecurring === false && c.component.componentType === 'earning');
  if (shared.length === 0 || onceOff.length === 0) return [];
  const key = (c: EmployeeComponent) => `${c.assignmentId ?? c.component.id}:${c.amount.toFixed(2)}`;
  const pairKey = `share[${shared.map(key).sort().join(',')}]once[${onceOff.map(key).sort().join(',')}]`;
  const shares = shared.map((c) => `${c.component.name} (${describeShare(c.share!)})`).join(', ');
  const extras = onceOff.map((c) => `${c.component.name} ${c.amount.toFixed(2)}`).join(', ');
  return [{
    code: SHARE_BESIDE_ONCE_OFF, severity: 'warning', field: 'components', pairKey,
    message: `${shares} ran for part of this period and ${shared.length === 1 ? 'is' : 'are'} paid ${shared.length === 1 ? 'its' : 'their'} share, `
      + `and a once-off earning is paid in the same period (${extras}). If a once-off was entered by hand to pro-rate the same days, `
      + 'those days are paid twice: end or reduce it, then recalculate. Otherwise an owner or admin acknowledges it on the run page '
      + 'before approval.',
  }];
}
