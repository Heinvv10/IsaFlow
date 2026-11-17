/**
 * The 13-week cash forecast's stored inputs, as the engine takes them (migration 999i). Shared by the
 * data layer (itemsRepo, overridesRepo, payDaySetting) and the engine. Dates are 'YYYY-MM-DD'; amounts
 * are rand, at most two decimals.
 */

/**
 * set/add amounts are SIGNED in the line's own sign (a payment cell is negative; the UI takes the sign from the line).
 * set: the week's figure becomes `amount`.
 * add: `amount` (never 0) is added to the week's figure.
 * move_to: `amount` (a magnitude, > 0) of the week's figure moves to `targetWeekStart`; null = the whole cell.
 */
export type OverrideMode = 'set' | 'add' | 'move_to';

export interface ForecastOverride {
  /** The engine's stable line key, e.g. 'ar:<customerId>', 'ap:<supplierId>', 'payroll:net', 'sars:vat201', 'manual:<itemId>'. */
  lineKey: string;
  /** A Monday. Overrides for past weeks are kept and ignored by the engine. */
  weekStart: string;
  mode: OverrideMode;
  /** Required for set/add; null only for move_to (the whole cell). */
  amount: number | null;
  /** move_to only: a Monday other than weekStart. */
  targetWeekStart?: string;
}

export type ManualItemDirection = 'receipt' | 'payment';
export type ManualItemRepeat = 'none' | 'weekly' | 'monthly';
/** The engine's CashCategory list (cashForecast13/types.ts), for grouping a manual item. */
export const CASH_CATEGORIES = ['customer_receipts', 'supplier_payments', 'payroll', 'sars', 'loans', 'other'] as const;
export type ManualItemCategory = (typeof CASH_CATEGORIES)[number];

export interface ManualCashItem {
  id: string;
  direction: ManualItemDirection;
  /** > 0; the direction gives the sign. */
  amount: number;
  /** The first (or only) expected date. */
  date: string;
  repeat: ManualItemRepeat;
  /** Last date a repeat may fall on (inclusive); null = open-ended, always null when repeat is 'none'. */
  repeatUntil: string | null;
  description: string;
  category: ManualItemCategory;
  accountId?: string;
}

/** Salaries paid on day N (1-31; beyond the month's length = its last day) or on the last working day. Default day 25. */
export type PayDayRule = { kind: 'day_of_month'; day: number } | { kind: 'last_working_day' };

export const DEFAULT_PAY_DAY = 25;

/** The engine's line key of a manual item; its overrides are deleted with it. */
export const manualLineKey = (itemId: string) => `manual:${itemId}`;

/** Per-company caps on the LIVE stored inputs (this week on; checked under a lock in the write transaction). */
export const MAX_ITEMS = 500;
export const MAX_OVERRIDES = 2000;
/** Hard caps on every row, live or not. */
export const MAX_ITEMS_TOTAL = 2000;
export const MAX_OVERRIDES_TOTAL = 10000;
