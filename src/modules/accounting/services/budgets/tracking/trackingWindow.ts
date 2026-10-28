/**
 * The Budget vs Actual tracking window (budgets P3 spec §2.2).
 *
 * Budgets are calendar-month amounts (migration 944), so a window always
 * starts on the 1st of a month and ends on a month end, for the actuals too,
 * including the in-progress month (P0's whole-month rule; the page says
 * "actuals posted through ..." instead of cutting the window at today).
 *
 * Financial years come from the registry (`gl/fiscalYearRegistry`), never from
 * `financial_year_start`, and nothing assumes twelve months: a quarter is a
 * 3-month block counted from the FY start, the last one short (a 14-month
 * year's Q5 has 2 months). A registry year that does not start on the 1st or
 * end on a month end would split a budget month, so it is refused (409)
 * rather than silently shifted.
 *
 * Dates are 'YYYY-MM-DD' strings throughout; no Date is built to read a month
 * (see `reports/budgetPeriodWindow.ts`).
 */
import { addDaysISO, localISODate } from '@/lib/dateUtils';
import {
  dayBefore,
  fiscalYearForDate,
  getFiscalYear,
  type FiscalYearRecord,
} from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { budgetMonthKeysInWindow, monthEnd } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import { TrackingError, type TrackingWindow, type TrackingWindowParams, type WindowYear } from './trackingTypes';

/** The registry reads a window needs; faked in the unit tests. */
export interface YearSource {
  byLabel(label: number): Promise<FiscalYearRecord | null>;
  forDate(date: string): Promise<FiscalYearRecord>;
}

export function registryYears(companyId: string): YearSource {
  return {
    byLabel: (label) => getFiscalYear(companyId, label),
    forDate: (date) => fiscalYearForDate(companyId, date),
  };
}

/** A custom range wider than this is a 400 (spec §4). */
export const MAX_CUSTOM_MONTHS = 24;
/** A window is at most 24 months, so it touches at most 25 one-month years; anything more is a bug. */
const MAX_YEARS = 40;

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthParam(name: string, raw: string | undefined): string {
  if (raw === undefined) throw new TrackingError(400, `${name} is required (YYYY-MM)`);
  if (!MONTH_KEY.test(raw)) {
    throw new TrackingError(400, `${name} must be a month (YYYY-MM): a budget month cannot be split without inventing a number`);
  }
  return raw;
}

function assertCalendarMonths(year: FiscalYearRecord): FiscalYearRecord {
  if (!year.startDate.endsWith('-01') || year.endDate !== monthEnd(year.endDate)) {
    throw new TrackingError(409,
      `FY${year.fiscalYear} runs ${year.startDate} to ${year.endDate}: budgets are whole calendar months, so it cannot be tracked`);
  }
  return year;
}

async function yearByLabel(src: YearSource, label: number): Promise<FiscalYearRecord> {
  const year = await src.byLabel(label);
  if (!year) throw new TrackingError(404, `No financial year is labelled ${label}`);
  return assertCalendarMonths(year);
}

async function chosenOrCurrent(src: YearSource, label: number | undefined, today: string): Promise<FiscalYearRecord> {
  return label === undefined ? assertCalendarMonths(await src.forDate(today)) : yearByLabel(src, label);
}

/** Each financial year the window [start, end] touches, with its months inside it. */
async function yearsOf(src: YearSource, startDate: string, endDate: string): Promise<{ years: WindowYear[]; last: FiscalYearRecord | null }> {
  const years: WindowYear[] = [];
  let last: FiscalYearRecord | null = null;
  let day = startDate;
  while (day <= endDate) {
    if (years.length >= MAX_YEARS) throw new Error(`tracking window ${startDate}..${endDate} spans too many years`);
    const year = assertCalendarMonths(await src.forDate(day));
    const from = year.startDate > startDate ? year.startDate : startDate;
    const to = year.endDate < endDate ? year.endDate : endDate;
    years.push({ fiscalYear: year.fiscalYear, months: budgetMonthKeysInWindow(from, to) });
    last = year;
    day = addDaysISO(year.endDate, 1);
  }
  return { years, last };
}

interface Span { startDate: string; endDate: string; label: string; fy?: FiscalYearRecord; notStarted?: boolean }

async function spanOf(src: YearSource, p: TrackingWindowParams, today: string): Promise<Span> {
  switch (p.period) {
    case 'month': {
      const month = p.month === undefined ? today.slice(0, 7) : monthParam('month', p.month);
      return { startDate: `${month}-01`, endDate: monthEnd(`${month}-01`), label: month };
    }
    case 'quarter': {
      const fy = await chosenOrCurrent(src, p.fiscalYear, today);
      const months = budgetMonthKeysInWindow(fy.startDate, fy.endDate);
      const count = Math.ceil(months.length / 3);
      const holding = months.indexOf(today.slice(0, 7));
      const quarter = p.quarter ?? (holding >= 0 ? Math.floor(holding / 3) + 1 : 1);
      if (!Number.isInteger(quarter) || quarter < 1 || quarter > count) {
        throw new TrackingError(400, `FY${fy.fiscalYear} has ${months.length} months: quarter must be 1 to ${count}`);
      }
      const block = months.slice(3 * (quarter - 1), Math.min(3 * quarter, months.length));
      const label = block.length < 3 ? `Q${quarter} (${block.length} month${block.length === 1 ? '' : 's'})` : `Q${quarter}`;
      return { startDate: `${block[0]!}-01`, endDate: monthEnd(`${block[block.length - 1]!}-01`), label, fy };
    }
    case 'ytd': {
      const fy = await chosenOrCurrent(src, p.fiscalYear, today);
      if (today < fy.startDate) {
        return { startDate: fy.startDate, endDate: dayBefore(fy.startDate), label: `FY${fy.fiscalYear} to date`, fy, notStarted: true };
      }
      const toMonthEnd = monthEnd(today);
      return { startDate: fy.startDate, endDate: toMonthEnd > fy.endDate ? fy.endDate : toMonthEnd, label: `FY${fy.fiscalYear} to date`, fy };
    }
    case 'fy': {
      const fy = await chosenOrCurrent(src, p.fiscalYear, today);
      return { startDate: fy.startDate, endDate: fy.endDate, label: `FY${fy.fiscalYear}`, fy };
    }
    case 'custom': {
      const from = monthParam('from', p.from);
      const to = monthParam('to', p.to);
      if (from > to) throw new TrackingError(400, 'from must not be after to');
      const span = budgetMonthKeysInWindow(`${from}-01`, `${to}-01`).length;
      if (span > MAX_CUSTOM_MONTHS) throw new TrackingError(400, `A custom range is at most ${MAX_CUSTOM_MONTHS} months (this one is ${span})`);
      return { startDate: `${from}-01`, endDate: monthEnd(`${to}-01`), label: `${from} to ${to}` };
    }
  }
}

/** The window a request names, against any year source (the pure core). */
export async function resolveTrackingWindowFrom(src: YearSource, p: TrackingWindowParams, today: string): Promise<TrackingWindow> {
  const span = await spanOf(src, p, today);
  if (span.notStarted && span.fy) {
    return {
      period: p.period, label: span.label, startDate: span.startDate, endDate: span.endDate, months: [],
      fiscalYear: span.fy.fiscalYear, fy: span.fy, years: [], inProgressMonth: null, notStarted: true,
    };
  }
  const { years, last } = await yearsOf(src, span.startDate, span.endDate);
  // FY*: the year holding the window's end, which the walk reaches last.
  const fy = last ?? span.fy;
  if (!fy) throw new Error(`tracking window ${span.startDate}..${span.endDate} holds no financial year`);
  const months = budgetMonthKeysInWindow(span.startDate, span.endDate);
  const todayMonth = today.slice(0, 7);
  return {
    period: p.period, label: span.label, startDate: span.startDate, endDate: span.endDate, months,
    fiscalYear: fy.fiscalYear, fy, years,
    inProgressMonth: months.includes(todayMonth) ? todayMonth : null,
    notStarted: false,
  };
}

/** The window a request names, from the company's registry. */
export async function resolveTrackingWindow(companyId: string, p: TrackingWindowParams, now: Date = new Date()): Promise<TrackingWindow> {
  return resolveTrackingWindowFrom(registryYears(companyId), p, localISODate(now));
}
