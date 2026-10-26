/** Shared helpers for the change-of-financial-year-end wizard. */
import { ApiRequestError, apiFetch } from '@/lib/apiFetch';
import { sastISODate } from '@/utils/dateFormat';

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

export const CARD_CLS = 'bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6';
export const BTN_PRIMARY = 'px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed';
export const BTN_SECONDARY = 'px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]';

export const MIN_REASON = 10;

/** 'YYYY-MM-DD' for display, built from its parts (no timezone round-trip). Anything that is not exactly that, or not a real day, is shown as it came. */
export function fmtDay(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = mo === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(mo) ? 30 : 31;
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth) return date;
  return `${d} ${MONTH_NAMES[mo - 1]!.slice(0, 3)} ${y}`;
}

/** The South African calendar day of a timestamp (an ISO instant), for display. */
export function fmtInstantDay(iso: string): string {
  const day = sastISODate(iso); // pinned to Africa/Johannesburg, whatever the browser's zone
  return day ? fmtDay(day) : iso; // not a date: shown as it came
}

/**
 * What to call the year a change would apply to. It is the year holding today,
 * unless that one is already closed: then it is the next open year, and calling
 * it "current" would be wrong.
 */
export function yearToChangeHeading(year: { startDate: string; endDate: string }, today: string): string {
  return today >= year.startDate && today <= year.endDate ? 'Current financial year' : 'Next open financial year';
}

export function monthOf(date: string): number {
  return Number(date.split('-')[1]);
}

/** Refusals the server sent with a 409, else the single message. */
export class YearEndRefusedError extends ApiRequestError {
  constructor(message: string, readonly refusals: string[]) {
    super(message, 409);
    this.name = 'YearEndRefusedError';
  }
}

/** POST or DELETE the change route; a refusal throws YearEndRefusedError carrying its list. */
export async function sendYearEndChange(method: 'POST' | 'DELETE', body: Record<string, unknown>): Promise<unknown> {
  const res = await apiFetch('/api/accounting/financial-year-end-change', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return ((await res.json()) as { data?: unknown }).data;
  // A refusal carries its list in error.details.refusals, which apiJson drops.
  const text = await res.text();
  let json: { error?: { message?: string; details?: { refusals?: unknown } } };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    json = {}; // a non-JSON error body: the generic sentence below says what failed
  }
  const message = json.error?.message ?? 'The change could not be completed - try again';
  const raw = json.error?.details?.refusals;
  const refusals = Array.isArray(raw) ? raw.map(String) : [];
  if (refusals.length > 0) throw new YearEndRefusedError(message, refusals);
  throw new ApiRequestError(message, res.status);
}
