/**
 * How long an employee may use the self-service portal (wave 6 SS; ruling §0a.14). Pure, no DB.
 *
 * A leaver (an `end_date` on file) keeps read-only access until the end of the NEXT tax year: the SA tax year ends on
 * the last day of February, so an end date in March 2026 to February 2027 (tax year 2027) gives access to the end of
 * February 2028. On the day after, the login is disabled. An employee with no end date has access while their status
 * is `active`; any other status with no end date (a hand edit) is refused, failing closed.
 *
 * "Today" is South Africa's date, as every payroll date is.
 */

export interface PortalEmployeeStanding { status: string; endDate: string | Date | null }

function ymd(d: string | Date): string {
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

/** The last day a leaver with this end date may sign in (YYYY-MM-DD). */
export function leaverAccessEnds(endDate: string | Date): string {
  const [y, m] = ymd(endDate).split('-').map(Number) as [number, number];
  const taxYearEnds = m >= 3 ? y + 1 : y;
  const last = taxYearEnds + 1;
  const leap = (last % 4 === 0 && last % 100 !== 0) || last % 400 === 0;
  return `${last}-02-${leap ? '29' : '28'}`;
}

/** Today's date in South Africa (YYYY-MM-DD). */
export function todaySast(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

/** The last day of access, or null when there is no limit; 'closed' when the employee may not sign in at all. */
export function portalAccessEnds(e: PortalEmployeeStanding): string | null | 'closed' {
  if (e.endDate) return leaverAccessEnds(e.endDate);
  return e.status === 'active' ? null : 'closed';
}

export function portalAccessOpen(e: PortalEmployeeStanding, today: string = todaySast()): boolean {
  const ends = portalAccessEnds(e);
  return ends === null || (ends !== 'closed' && today <= ends);
}
