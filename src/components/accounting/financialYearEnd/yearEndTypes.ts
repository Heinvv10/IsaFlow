/** Shared helpers for the change-of-financial-year-end wizard. */
import { ApiRequestError, apiFetch } from '@/lib/apiFetch';

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

export const CARD_CLS = 'bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6';
export const BTN_PRIMARY = 'px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed';
export const BTN_SECONDARY = 'px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]';

export const MIN_REASON = 10;

/** 'YYYY-MM-DD' for display, built from its parts (no timezone round-trip). */
export function fmtDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTH_NAMES[m - 1]!.slice(0, 3)} ${y}`;
}

/** The South African calendar day of a timestamp (an ISO instant), for display. */
export function fmtInstantDay(iso: string): string {
  return fmtDay(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date(iso)));
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
