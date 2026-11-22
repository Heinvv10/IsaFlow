/**
 * What a POSTING date may be, judged in the browser before save (date rework 4/4): a date inside a closed or locked
 * fiscal period is refused (the server refuses it too when the document is POSTED: ClosedFiscalPeriodError). `draftOnly` (a form that only saves a draft, proven in closed-period-post-refusal.int.test.ts) warns instead of blocking; a date outside the current financial
 * year only warns. Pure ISO-string logic; the periods come from GET /api/accounting/fiscal-periods (useFiscalCalendar).
 * A date no period covers is NOT blocked: the server creates the period on posting. A `closing` period counts as closed
 * (posting into it is refused). Nothing is judged until the periods have loaded (`periods === null`).
 */
import { presetRange } from './fiscalRangePresets';

export interface PeriodLite {
  periodName: string;
  fiscalYear: number;
  periodNumber: number;
  startDate: string;
  endDate: string;
  status: string;
}

export type PostingDateCode = 'closed-period' | 'outside-fy';
export type PostingDateCheck =
  | { level: null; code: null; message: null }
  | { level: 'block' | 'warn'; code: PostingDateCode; message: string };

const NONE: PostingDateCheck = { level: null, code: null, message: null };
// `closing` too: postJournalEntry refuses every non-open period, so a date there can never be posted.
const BLOCKING = new Set(['closed', 'locked', 'closing']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-03-01' -> '1 Mar 2026' (fixed table: the date census forbids Intl here). */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The financial year that holds `today`: from its periods when loaded, else from the company's start month. */
export function currentFiscalYear(
  periods: readonly PeriodLite[] | null, today: string, fyStartMonth: number,
): { start: string; end: string } {
  const holding = (periods ?? []).find((p) => p.startDate <= today && today <= p.endDate);
  if (holding) {
    const year = (periods ?? []).filter((p) => p.fiscalYear === holding.fiscalYear);
    return { start: year.map((p) => p.startDate).sort()[0] as string, end: year.map((p) => p.endDate).sort().at(-1) as string };
  }
  const r = presetRange('this_fy', today, fyStartMonth);
  return { start: (r as { from: string }).from, end: (r as { to: string }).to };
}

export function checkPostingDate(
  iso: string, periods: readonly PeriodLite[] | null, today: string, fyStartMonth: number, draftOnly = false,
): PostingDateCheck {
  if (periods === null) return NONE;
  const hit = periods.find((p) => p.startDate <= iso && iso <= p.endDate && BLOCKING.has(p.status));
  if (hit && draftOnly) {
    return {
      level: 'warn', code: 'closed-period',
      message: `${shortDate(iso)} is in ${hit.periodName}, which is ${hit.status}. You can save a draft, but it cannot be posted until that period is open.`,
    };
  }
  if (hit) {
    return {
      level: 'block', code: 'closed-period',
      message: `${shortDate(iso)} is in ${hit.periodName}, which is ${hit.status}. Choose a date in an open period.`,
    };
  }
  const fy = currentFiscalYear(periods, today, fyStartMonth);
  if (iso < fy.start || iso > fy.end) {
    return {
      level: 'warn', code: 'outside-fy',
      message: `${shortDate(iso)} is outside the current financial year (${shortDate(fy.start)} to ${shortDate(fy.end)}).`,
    };
  }
  return NONE;
}

/** `y` = first day of the financial year, `r` = last day (QuickBooks letters, on the financial year). */
export function fiscalYearShortcut(text: string, fy: { start: string; end: string }): string | null {
  const t = text.trim().toLowerCase();
  return t === 'y' ? fy.start : t === 'r' ? fy.end : null;
}
