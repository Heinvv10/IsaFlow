/** Turns the window a question named into dates. Pure: `today` is passed in (YYYY-MM-DD, South African date). */
import type { AskPeriod } from './askIntents';

export interface ResolvedPeriod { from: string; to: string; label: string }

const pad = (n: number): string => String(n).padStart(2, '0');
const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function wholeMonth(y: number, m: number): ResolvedPeriod {
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}`, label: `${MONTH_NAMES[m - 1]} ${y}` };
}

/**
 * `dflt` says what to use when the question named no window. A month named without a year is the latest such
 * month not after `today`'s month (so "October" asked in November means this October, in January last October).
 */
export function resolvePeriod(
  period: AskPeriod | null, today: string, dflt: 'month_to_date' | 'last_month', fyStartMonth: number,
): ResolvedPeriod {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const p: AskPeriod = period ?? (dflt === 'last_month' ? { kind: 'last_month' } : { kind: 'this_month' });
  if (p.kind === 'last_month') return m === 1 ? wholeMonth(y - 1, 12) : wholeMonth(y, m - 1);
  if (p.kind === 'this_month') return { from: `${y}-${pad(m)}-01`, to: today, label: `${MONTH_NAMES[m - 1]} ${y} to date` };
  if (p.kind === 'this_year') {
    const startYear = m >= fyStartMonth ? y : y - 1;
    return { from: `${startYear}-${pad(fyStartMonth)}-01`, to: today, label: `this financial year to date` };
  }
  const year = p.year ?? (p.month <= m ? y : y - 1);
  return wholeMonth(year, p.month);
}
