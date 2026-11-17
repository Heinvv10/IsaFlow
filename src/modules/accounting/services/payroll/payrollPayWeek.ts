/**
 * The pay week (wave 6 FQd; Hein ruling §0a.13): which dates a weekly or fortnightly run pays for, and when it pays.
 * Pure (no database), so the new-run page lists the same periods the route accepts.
 *
 * Settings (payroll_company_settings, migration 999a; no row = the defaults): ISO day numbers, 1 = Monday.
 *   pay_week_start_dow  the day a pay week starts (default 1, Monday-Sunday);
 *   pay_weekday         the day it is paid (default 5, Friday);
 *   fortnight_anchor    the start of one fortnight; every fortnight starts a multiple of 14 days from it. It must fall on
 *                       the pay-week start day, and a fortnightly run needs it (400 otherwise).
 *
 * A period: weekly 7 days, fortnightly 14, starting on the pay-week start day. Its pay date is the pay weekday in the
 * period's last 7 days (Mon-Sun paid Friday: the Friday of the week; of the second week for a fortnight). The run's
 * period_year / period_month are the PAY DATE's month: the EMP201 month (Fourth Schedule para 2(1): PAYE is paid
 * within seven days after the month in which it was deducted; spec FQc).
 */
import type { PayFrequency } from './payrollTypesRun';

export type PeriodFrequency = Exclude<PayFrequency, 'monthly'>;

export interface PayWeekSettings {
  payWeekStartDow: number;
  payWeekday: number;
  fortnightAnchor: string | null;
}

export const DEFAULT_PAY_WEEK: PayWeekSettings = { payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: null };

export interface RunPeriod {
  periodStart: string;
  periodEnd: string;
  payDate: string;
  periodYear: number;
  periodMonth: number;
}

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const dayName = (dow: number): string => DAY_NAMES[dow - 1] ?? `day ${dow}`;

/** A period start or a setting refused, with the message the user sees (400). */
export class RunPeriodRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunPeriodRefused';
  }
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a real calendar date 'YYYY-MM-DD' in 2020-2100; null for anything else. */
export function dayNumber(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const m = ISO.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2020 || y > 2100) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

export const isoOfDay = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** ISO day of the week, 1 = Monday. 1970-01-01 was a Thursday (4). */
export const isoDow = (n: number): number => ((((n + 3) % 7) + 7) % 7) + 1;
export const periodDays = (f: PeriodFrequency): number => (f === 'weekly' ? 7 : 14);

const isDow = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 7;

/** The settings to store, judged whole; throws RunPeriodRefused. */
export function judgePayWeekSettings(input: { payWeekStartDow: unknown; payWeekday: unknown; fortnightAnchor: unknown }): PayWeekSettings {
  if (!isDow(input.payWeekStartDow)) throw new RunPeriodRefused('The pay week start must be a day number from 1 (Monday) to 7 (Sunday).');
  if (!isDow(input.payWeekday)) throw new RunPeriodRefused('The pay day must be a day number from 1 (Monday) to 7 (Sunday).');
  let anchor: string | null = null;
  if (input.fortnightAnchor !== null && input.fortnightAnchor !== undefined && input.fortnightAnchor !== '') {
    const n = dayNumber(input.fortnightAnchor);
    if (n === null) throw new RunPeriodRefused('The fortnight start must be a date (YYYY-MM-DD) from 2020 to 2100.');
    if (isoDow(n) !== input.payWeekStartDow) {
      throw new RunPeriodRefused(`The fortnight start must be a ${dayName(input.payWeekStartDow)}, the day the pay week starts; ${isoOfDay(n)} is a ${dayName(isoDow(n))}.`);
    }
    anchor = isoOfDay(n);
  }
  return { payWeekStartDow: input.payWeekStartDow, payWeekday: input.payWeekday, fortnightAnchor: anchor };
}

function periodFrom(start: number, f: PeriodFrequency, s: PayWeekSettings): RunPeriod {
  const end = start + periodDays(f) - 1;
  const pay = end - 6 + ((s.payWeekday - s.payWeekStartDow + 7) % 7);
  const payIso = isoOfDay(pay);
  return {
    periodStart: isoOfDay(start), periodEnd: isoOfDay(end), payDate: payIso,
    periodYear: Number(payIso.slice(0, 4)), periodMonth: Number(payIso.slice(5, 7)),
  };
}

/** The period starting on `periodStart`, or RunPeriodRefused naming why it is not one. */
export function resolveRunPeriod(f: PeriodFrequency, periodStart: unknown, s: PayWeekSettings): RunPeriod {
  const n = dayNumber(periodStart);
  if (n === null) throw new RunPeriodRefused('periodStart must be a date (YYYY-MM-DD) from 2020 to 2100.');
  if (isoDow(n) !== s.payWeekStartDow) {
    throw new RunPeriodRefused(`A ${f} period starts on a ${dayName(s.payWeekStartDow)} (the company's pay week); ${isoOfDay(n)} is a ${dayName(isoDow(n))}.`);
  }
  if (f === 'fortnightly') {
    const anchor = dayNumber(s.fortnightAnchor);
    if (anchor === null) throw new RunPeriodRefused('Set the fortnight start in the pay week settings before the first fortnightly run.');
    const off = (((n - anchor) % 14) + 14) % 14;
    if (off !== 0) {
      throw new RunPeriodRefused(`A fortnight starts every 14 days from ${isoOfDay(anchor)}: ${isoOfDay(n - off)} or ${isoOfDay(n - off + 14)}, not ${isoOfDay(n)}.`);
    }
  }
  return periodFrom(n, f, s);
}

/**
 * The periods to offer on the new-run page, newest first: from the one containing `today - back` days to the one
 * containing `today + ahead` days. Empty for a fortnight with no anchor (the page asks for the settings first).
 */
export function periodsAround(f: PeriodFrequency, s: PayWeekSettings, today: string, back = 91, ahead = 28): RunPeriod[] {
  const t = dayNumber(today);
  if (t === null) return [];
  const len = periodDays(f);
  const anchor = f === 'fortnightly' ? dayNumber(s.fortnightAnchor) : t - ((isoDow(t) - s.payWeekStartDow + 7) % 7);
  if (anchor === null) return [];
  const startOf = (day: number) => day - ((((day - anchor) % len) + len) % len);
  const out: RunPeriod[] = [];
  for (let start = startOf(t + ahead); start >= startOf(t - back); start -= len) {
    if (dayNumber(isoOfDay(start)) !== null) out.push(periodFrom(start, f, s));
  }
  return out;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (iso: string): string => `${Number(iso.slice(8, 10))} ${MONTH_ABBR[Number(iso.slice(5, 7)) - 1] ?? '?'}`;

/** '16 Nov - 22 Nov 2026', or '28 Dec 2026 - 3 Jan 2027' across a year end. */
export function formatPeriodRange(start: string, end: string): string {
  const sy = start.slice(0, 4);
  const ey = end.slice(0, 4);
  return sy === ey ? `${short(start)} - ${short(end)} ${ey}` : `${short(start)} ${sy} - ${short(end)} ${ey}`;
}

/** 'Fri 20 Nov 2026'. */
export function formatPayDate(iso: string): string {
  const n = dayNumber(iso);
  return n === null ? iso : `${dayName(isoDow(n)).slice(0, 3)} ${short(iso)} ${iso.slice(0, 4)}`;
}
