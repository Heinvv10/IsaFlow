/** Turns the window a question named into dates. Pure: `today` is passed in (YYYY-MM-DD, South African date). */
import type { AskPeriod } from './askIntents';

export interface ResolvedPeriod { from: string; to: string; label: string }
/** The registry's financial years around today, read only when a question says "this/last year". */
export interface FiscalYears { thisStart: string; lastStart: string; lastEnd: string }

const pad = (n: number): string => String(n).padStart(2, '0');
const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const wholeMonth = (y: number, m: number): ResolvedPeriod =>
  ({ from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}`, label: `${MONTH_NAMES[m - 1]} ${y}` });

/** The calendar month a month-type window means: a named month without a year is the latest one not after today's. */
export function monthOf(period: AskPeriod | null, today: string, dflt: 'this' | 'last'): { y: number; m: number } | null {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const p: AskPeriod = period ?? { kind: dflt === 'last' ? 'last_month' : 'this_month' };
  if (p.kind === 'this_month') return { y, m };
  if (p.kind === 'last_month') return m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  if (p.kind === 'month') return { y: p.year ?? (p.month <= m ? y : y - 1), m: p.month };
  return null;
}

/** A from/to window for flow figures (P&L). Null for a window it cannot honour (the caller says so). */
export function resolveWindow(period: AskPeriod | null, today: string, fy: FiscalYears | null): ResolvedPeriod | null {
  const p: AskPeriod = period ?? { kind: 'this_month' };
  if (p.kind === 'this_month') { const t = monthOf(p, today, 'this')!; return { from: `${t.y}-${pad(t.m)}-01`, to: today, label: `${MONTH_NAMES[t.m - 1]} ${t.y} to date` }; }
  if (p.kind === 'last_month' || p.kind === 'month') { const t = monthOf(p, today, 'this')!; return wholeMonth(t.y, t.m); }
  if (p.kind === 'this_year' && fy) return { from: fy.thisStart, to: today, label: 'this financial year to date' };
  if (p.kind === 'last_year' && fy) return { from: fy.lastStart, to: fy.lastEnd, label: 'last financial year' };
  return null;
}

/** The as-at date for point-in-time figures (balances, aging). Null for a window with no single date. */
export function resolveAsAt(period: AskPeriod | null, today: string): { date: string; label: string } | null {
  if (!period || period.kind === 'this_month' || period.kind === 'this_year') return { date: today, label: today };
  if (period.kind === 'last_month' || period.kind === 'month') {
    const t = monthOf(period, today, 'this')!;
    const end = wholeMonth(t.y, t.m).to;
    return { date: end > today ? today : end, label: end > today ? today : end };
  }
  return null;
}

/** How a window reads back to the person in a refusal. */
export function describePeriod(p: AskPeriod | null): string {
  if (!p) return 'that period';
  if (p.kind === 'unsupported') return p.said;
  if (p.kind === 'last_year') return 'last year';
  if (p.kind === 'this_year') return 'this year';
  return 'that period';
}
