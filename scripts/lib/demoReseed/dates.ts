/**
 * Pure date maths on `YYYY-MM-DD` strings, UTC only. No clock: every function
 * takes the dates it works on.
 */

import { DEMO_MONTHS_BACK } from './constants';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDay(d: string): void {
  if (!ISO_DAY.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || toIso(parse(d)) !== d) {
    throw new Error(`not a calendar day: ${d}`);
  }
}

function parse(d: string): Date {
  return new Date(`${d}T00:00:00Z`);
}

function toIso(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  const dt = parse(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return toIso(dt);
}

export function ym(d: string): { year: number; month: number } {
  return { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) };
}

export function monthStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function monthEnd(year: number, month: number): string {
  return toIso(new Date(Date.UTC(year, month, 0)));
}

export function addMonths(year: number, month: number, n: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** Clamp a day-of-month into the month (31 Feb -> 28/29 Feb). */
export function dayOf(year: number, month: number, day: number): string {
  const last = Number(monthEnd(year, month).slice(8, 10));
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

export function minDay(a: string, b: string): string {
  return a <= b ? a : b;
}

export interface Window {
  today: string;
  windowStart: string;
  lastMonthEnd: string;
  currentMonthStart: string;
  /** The 24 window months, oldest first; the last is the current (partial) month. */
  months: Array<{ year: number; month: number }>;
}

export function windowFor(today: string): Window {
  assertIsoDay(today);
  const { year, month } = ym(today);
  const start = addMonths(year, month, -DEMO_MONTHS_BACK);
  const months: Window['months'] = [];
  for (let i = 0; i <= DEMO_MONTHS_BACK; i++) months.push(addMonths(start.year, start.month, i));
  const prev = addMonths(year, month, -1);
  return {
    today,
    windowStart: monthStart(start.year, start.month),
    lastMonthEnd: monthEnd(prev.year, prev.month),
    currentMonthStart: monthStart(year, month),
    months,
  };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Oct 2026`: the only date form seeded text may carry (no ISO-style dates in text). */
export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** A timestamp at 09:00 SAST (07:00 UTC) on a day, as text pg accepts. */
export function at0900(d: string): string {
  return `${d}T07:00:00Z`;
}
