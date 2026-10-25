/**
 * Which transition years a change of financial year end may produce. Pure: no
 * database, dates as 'YYYY-MM-DD' strings built from integer components.
 *
 * THE LAW. Companies Act 71 of 2008, s27(4) (read from the Act as published in
 * Government Gazette 32121, 9 April 2009; confidence HIGH on the wording):
 *
 *   "The board of a company may change its financial year end at any time, by
 *    filing a notice of that change, but—
 *    (a) it may not do so more than once during any financial year;
 *    (b) the newly established financial year end must be later than the date
 *        on which the notice is filed; and
 *    (c) the date as changed may not result in a financial year ending more
 *        than 15 months after the end of the preceding financial year."
 *
 * (b) is stricter than the programme brief (which allowed any end at least a
 * month after the year's start): a shortened year must still end after today.
 * The Act wins (noted in the PR). (a) is checked by the service against the
 * change records; (b) and (c) here.
 *
 * The transition year is the CURRENT year, stretched or shrunk: it keeps its
 * start, and ends on the last day of the new year-end month. Every month stays a
 * calendar month; only which year a month belongs to changes.
 */

import { dayBefore, monthsSpanned } from './fiscalYearRegistry';

export interface TransitionYear {
  fiscalYear: number;
  startDate: string;
  endDate: string;
}

export type TransitionKind = 'shorten' | 'extend';

export interface TransitionOption {
  kind: TransitionKind;
  /** The transition year's new last day. */
  endDate: string;
  /** Calendar months the transition year will span (1-15). */
  months: number;
  /** companies.financial_year_start after the change (the month after the new year end). */
  newStartMonth: number;
  /** The first day of the year after the transition year. */
  nextYearStart: string;
}

export interface TransitionPlan {
  options: TransitionOption[];
  /** Why there is no option, in words a user can act on (empty when there are options). */
  refusals: string[];
}

export const MAX_TRANSITION_MONTHS = 15;

function lastDayOf(year: number, month: number): string {
  const last = new Date(year, month, 0).getDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

function dayAfter(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(y, m - 1, d + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

/**
 * The transition years a new year-end month allows for `year`, today being
 * `today` (the date the notice is treated as filed).
 */
export function planTransition(year: TransitionYear, newYearEndMonth: number, today: string): TransitionPlan {
  if (!Number.isInteger(newYearEndMonth) || newYearEndMonth < 1 || newYearEndMonth > 12) {
    return { options: [], refusals: [`The new year-end month must be 1-12 (got ${String(newYearEndMonth)}).`] };
  }
  const startYear = Number(year.startDate.slice(0, 4));
  const startMonth = Number(year.startDate.slice(5, 7));
  // s27(4)(c): no later than 15 months after the end of the preceding year,
  // which is the day before this year starts.
  const latestAllowed = lastDayOf(startYear + Math.floor((startMonth - 1 + MAX_TRANSITION_MONTHS - 1) / 12),
    ((startMonth - 1 + MAX_TRANSITION_MONTHS - 1) % 12) + 1);
  const earliest = lastDayOf(startYear, startMonth);

  const options: TransitionOption[] = [];
  const refusals = new Set<string>();
  for (let y = startYear; y <= startYear + 2; y++) {
    const end = lastDayOf(y, newYearEndMonth);
    if (end < earliest) continue;
    if (end === year.endDate) {
      refusals.add(`FY${year.fiscalYear} already ends on ${end}.`);
      continue;
    }
    if (end > latestAllowed) {
      refusals.add(`A year end of ${end} would make FY${year.fiscalYear} longer than ${MAX_TRANSITION_MONTHS} months `
        + `after the previous year end (${dayBefore(year.startDate)}); the Companies Act s27(4)(c) does not allow it.`);
      continue;
    }
    if (end <= today) {
      refusals.add(`A year end of ${end} has already passed; the Companies Act s27(4)(b) requires the new year end `
        + 'to be later than the date the change is filed.');
      continue;
    }
    options.push({
      kind: end < year.endDate ? 'shorten' : 'extend',
      endDate: end,
      months: monthsSpanned(year.startDate, end),
      newStartMonth: (newYearEndMonth % 12) + 1,
      nextYearStart: dayAfter(end),
    });
  }
  return { options, refusals: options.length > 0 ? [] : [...refusals] };
}
